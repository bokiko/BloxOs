package main

import (
	"testing"
	"time"

	"github.com/bokiko/bloxos/proto/powerhistory"
)

func fpComponents(cpu, gpu float64) powerhistory.Bucket {
	return powerhistory.Bucket{CPU: fpStats(cpu, cpu+1, 30), GPUTotal: fpStats(gpu, gpu+1, 30),
		Sources: []powerhistory.DomainSource{{Domain: powerhistory.DomainCPU, Source: powerhistory.SourceRAPLPackage}}}
}

func TestFleetPowerTotalUsesOnlyPairedMachineWindows(t *testing.T) {
	const start int64 = 1_000_000
	paired := fpComponents(48, 299)
	cpuOnly := fpComponents(900, 0)
	cpuOnly.GPUTotal = nil
	gpuOnly := fpComponents(0, 800)
	gpuOnly.CPU = nil
	// Same chart bin is insufficient: these two windows must not be paired.
	records := []fleetPowerRecord{
		fpRecord("paired", start+30_000, paired),
		fpRecord("split", start+30_000, cpuOnly),
		fpRecord("split", start+60_000, gpuOnly),
		fpRecord("cpu-only", start+30_000, cpuOnly),
		fpRecord("gpu-only", start+30_000, gpuOnly),
	}
	h := aggregateFleetPower(records, fpInputs([]string{"paired", "split", "cpu-only", "gpu-only"}, start, 1))
	d := fpDomain(t, h, fleetPowerDomainTotal)
	fpWatts(t, d.Buckets[0].MeasuredWatts, 347)
	if d.Buckets[0].MeasuredMachines != 1 {
		t.Fatalf("contributors: %+v", d.Buckets[0])
	}
	if d.Measured.SampleCount != 30 {
		t.Fatalf("paired samples = %d", d.Measured.SampleCount)
	}
}

func TestFleetPowerTotalRejectsIncompleteOrUnverifiedComponents(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*powerhistory.Bucket)
	}{
		{"missing", func(b *powerhistory.Bucket) { b.CPU = nil }},
		{"partial", func(b *powerhistory.Bucket) { b.CPU.Samples = 29 }},
		{"modelled", func(b *powerhistory.Bucket) { b.Sources[0].Source = powerhistory.SourceEstimateUtil }},
		{"unknown", func(b *powerhistory.Bucket) { b.Sources[0].Source = "unknown" }},
		{"wrong-domain", func(b *powerhistory.Bucket) { b.Sources[0].Source = powerhistory.SourceRAPLPsys }},
		{"frozen", func(b *powerhistory.Bucket) { b.CPU = fpStats(0, 0, 30) }},
		{"corrupt", func(b *powerhistory.Bucket) { b.GPUTotal = fpStats(-1, 0, 30) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := fpComponents(48, 299)
			tc.change(&b)
			if r := fleetPowerReadingFor(&b, fleetPowerDomainTotal, 30); r.reason == "" {
				t.Fatalf("invalid total: %+v", r)
			}
		})
	}
	b := fpComponents(0, 0) // positive CPU peak, zero mean is valid.
	if r := fleetPowerReadingFor(&b, fleetPowerDomainTotal, 30); r.reason != "" || r.watts != 0 {
		t.Fatalf("real zero lost: %+v", r)
	}
}

func TestFleetPowerCurrentTotalAgreesWithRowsAndDoesNotFallBack(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	for _, id := range []string{"paired", "newest-missing", "stale"} {
		s.seedTestMachine(t, id)
	}
	now := time.Now().UnixMilli()
	b := fpComponents(48, 299)
	insertFleetPowerRow(t, s, "paired", 1, now-30_000, now, b)
	insertFleetPowerRow(t, s, "newest-missing", 1, now-60_000, now-30_000, b)
	b.GPUTotal = nil
	insertFleetPowerRow(t, s, "newest-missing", 2, now-30_000, now, b)
	insertFleetPowerRow(t, s, "stale", 1, now-330_000, now-300_000, fpComponents(900, 800))
	if _, err := s.db.Exec(`UPDATE machines SET hardware_info=? WHERE id='paired'`, `{"cpu_model":"AMD Ryzen AI 9 HX 370","gpu_devices":[{"vendor":"AMD","model":"Radeon 890M"}]}`); err != nil {
		t.Fatal(err)
	}
	out := fpCurrent(t, e, token)
	d := fpCurrentDomain(t, out, fleetPowerDomainTotal)
	fpWatts(t, d.Measured.Watts, 347)
	if d.Measured.Machines != 1 || d.StaleMachines != 1 {
		t.Fatalf("counts: %+v", d)
	}
	for _, m := range out.Machines {
		r := m.Domains[fleetPowerDomainTotal]
		if m.MachineID == "paired" {
			fpWatts(t, r.Watts, 347)
			if len(m.PowerHardware.GPUDevices) != 1 {
				t.Fatal("inventory caveat lost")
			}
		} else if r.Watts != nil {
			t.Fatalf("unavailable machine got total: %+v", m)
		}
	}
}
