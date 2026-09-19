package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/bokiko/bloxos/proto/powerhistory"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

// The chart request must cover the full day beyond both former row limits.
func TestFleetPowerHistoryFullDayBeyondFormerLimits(t *testing.T) {
	e, s := setupTestServer(t)
	const machines = 22
	const windows = 2880
	spec := fleetPowerPeriods["24h"]
	end := time.Now().Truncate(spec.bucket).Add(spec.bucket).UnixMilli()
	start := end - spec.window.Milliseconds()
	var ids []string
	for m := 0; m < machines; m++ {
		id := fmt.Sprintf("full-day-%02d", m)
		ids = append(ids, id)
		s.seedTestMachine(t, id)
	}
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT INTO power_history_records
 (machine_id,stream_id,seq,start_unix_ms,end_unix_ms,expected_samples,payload)
 VALUES (?,'full-day',?,?,?,30,?)`)
	if err != nil {
		t.Fatal(err)
	}
	defer stmt.Close()
	var reference []fleetPowerRecord
	for m, id := range ids {
		bk := powerhistory.Bucket{CPU: fpStats(10, 12, 30), Sources: []powerhistory.DomainSource{{Domain: powerhistory.DomainCPU, Source: powerhistory.SourceRAPLPackage}}}
		if m < 5 {
			bk.GPUTotal = fpStats(50, 60, 30)
		}
		if m == 0 {
			bk.System = fpStats(12, 14, 30)
			bk.Sources = append(bk.Sources, powerhistory.DomainSource{Domain: powerhistory.DomainSystem, Source: powerhistory.SourceEstimateUtil})
		}
		if m == 1 {
			bk.System = fpStats(99, 100, 30)
			bk.Sources = append(bk.Sources, powerhistory.DomainSource{Domain: powerhistory.DomainSystem, Source: "hwmon:ina226"})
		}
		for n := 1; n <= windows; n++ {
			rowEnd := start + int64(n)*30_000
			bk.GapBefore = m == 0 && n == 31
			payload, err := json.Marshal(bk)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := stmt.Exec(id, n, rowEnd-30_000, rowEnd, string(payload)); err != nil {
				t.Fatal(err)
			}
			reference = append(reference, fpRecord(id, rowEnd, bk))
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/fleet/power/history?period=24h", nil)
	rec := httptest.NewRecorder()
	if err := s.handleFleetPowerHistory(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got FleetPowerHistory
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.StartUnixMS != start || got.Coverage.Truncated {
		t.Fatalf("full window lost: start=%d want=%d coverage=%+v", got.StartUnixMS, start, got.Coverage)
	}
	want := aggregateFleetPower(reference, fleetPowerInputs{Period: "24h", Spec: spec, StartMS: start, BucketCount: 96, Now: got.GeneratedUnixMS, MachineIDs: ids})
	if !reflect.DeepEqual(got, want) {
		t.Fatal("streamed endpoint differs from complete reference aggregation")
	}
	cpu := fpDomain(t, got, powerhistory.DomainCPU)
	gpu := fpDomain(t, got, fleetPowerDomainGPU)
	for i := range cpu.Buckets {
		fpWatts(t, cpu.Buckets[i].MeasuredWatts, machines*10)
		fpWatts(t, gpu.Buckets[i].MeasuredWatts, 250)
	}
	t.Logf("read %d rows across %d machines into %d chart buckets", machines*windows, machines, len(cpu.Buckets))
}

func TestFleetPowerExplicitCapCountsRawRowsAndRequiresLookahead(t *testing.T) {
	_, s := setupTestServer(t)
	s.seedTestMachine(t, "m")
	in := fpInputs([]string{"m"}, 1_000_000, 3)
	in.Now = in.StartMS + 180_000
	for _, tc := range []struct {
		name               string
		count              int
		corrupt, truncated bool
	}{
		{"below limit", 1, false, false}, {"exact limit", 2, false, false}, {"above limit", 3, false, true},
		{"corrupt row at exact limit", 2, true, false}, {"corrupt row cannot conceal truncation", 3, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.db.Exec("DELETE FROM power_history_records"); err != nil {
				t.Fatal(err)
			}
			for n := 1; n <= tc.count; n++ {
				end := in.StartMS + int64(n)*30_000
				insertFleetPowerRow(t, s, "m", uint64(n), end-30_000, end, fpSystem(100, powerhistory.SourceIPMIDCMI))
			}
			if tc.corrupt {
				if _, err := s.db.Exec("UPDATE power_history_records SET payload='invalid' WHERE seq=?", tc.count); err != nil {
					t.Fatal(err)
				}
			}
			h, err := s.readFleetPowerHistory(context.Background(), in, 2)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.truncated && h.StartUnixMS != in.StartMS {
				t.Fatal("uncapped coverage start was narrowed")
			}
			if h.Coverage.Truncated != tc.truncated {
				t.Fatalf("truncated=%v want %v", h.Coverage.Truncated, tc.truncated)
			}
		})
	}
}

func TestFleetPowerCapKeepsOnlyWholeChartBins(t *testing.T) {
	_, s := setupTestServer(t)
	s.seedTestMachine(t, "m1")
	s.seedTestMachine(t, "m2")
	in := fpInputs([]string{"m1", "m2"}, 1_000_000, 3)
	in.Now = in.StartMS + 180_000
	for n := 1; n <= 3; n++ {
		for _, id := range in.MachineIDs {
			end := in.StartMS + int64(n)*60_000
			insertFleetPowerRow(t, s, id, uint64(n), end-30_000, end, fpSystem(100, powerhistory.SourceIPMIDCMI))
		}
	}
	for _, limit := range []int{1, 2, 3, 4, 6} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			h, err := s.readFleetPowerHistory(context.Background(), in, limit)
			if err != nil {
				t.Fatal(err)
			}
			d := fpDomain(t, h, powerhistory.DomainSystem)
			first := 3 - limit/2
			for i, b := range d.Buckets {
				if b.StartUnixMS != in.StartMS+int64(i)*60_000 {
					t.Fatal("truncation shifted the aggregation grid")
				}
				if i < first {
					if b.MeasuredWatts != nil {
						t.Fatalf("cut bin %d contains %v", i, *b.MeasuredWatts)
					}
				} else {
					fpWatts(t, b.MeasuredWatts, 200)
				}
			}
			if h.StartUnixMS != in.StartMS+int64(first)*60_000 {
				t.Fatalf("start=%d want first whole bin %d", h.StartUnixMS, first)
			}
			if d.Measured.SampleCount != int64((limit/2)*2*30) {
				t.Fatalf("cut bin leaked into rollup: %+v", d.Measured)
			}
		})
	}
}

func TestFleetPowerCancelledReadReturnsErrorNotPartialSuccess(t *testing.T) {
	e, s := setupTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h, err := s.readFleetPowerHistory(ctx, fpInputs(nil, 0, 2), 0)
	if err == nil {
		t.Fatal("cancelled read succeeded")
	}
	if len(h.Domains) != 0 {
		t.Fatal("partial history leaked")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/fleet/power/history", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	if err := s.handleFleetPowerHistory(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("cancelled handler status %d", rec.Code)
	}
}

// This measures the aggregation independently of SQLite and bcrypt fixtures.
// Records are generated lazily: the benchmark must not allocate a day of input.
func BenchmarkFleetPowerFullDayStream(b *testing.B) {
	for _, machines := range []int{11, 100} {
		b.Run(fmt.Sprint(machines), func(b *testing.B) {
			in := fleetPowerInputs{Period: "24h", Spec: fleetPowerPeriods["24h"], StartMS: 1_000_000, BucketCount: 96, Now: 100_000_000}
			for m := 0; m < machines; m++ {
				in.MachineIDs = append(in.MachineIDs, fmt.Sprint(m))
			}
			bk := powerhistory.Bucket{System: fpStats(100, 110, 30), CPU: fpStats(20, 30, 30), DRAM: fpStats(5, 10, 30), GPUTotal: fpStats(50, 60, 30),
				Sources: []powerhistory.DomainSource{{Domain: powerhistory.DomainSystem, Source: powerhistory.SourceIPMIDCMI}, {Domain: powerhistory.DomainCPU, Source: powerhistory.SourceRAPLPackage}, {Domain: powerhistory.DomainDRAM, Source: powerhistory.SourceRAPLDRAM}}}
			records := func(yield func(fleetPowerRecord) bool) {
				for _, id := range in.MachineIDs {
					for n := 1; n <= 2880; n++ {
						if !yield(fpRecord(id, in.StartMS+int64(n)*30_000, bk)) {
							return
						}
					}
				}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for n := 0; n < b.N; n++ {
				aggregateFleetPowerStream(records, &in)
			}
		})
	}
}
