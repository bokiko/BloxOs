package main

import "github.com/bokiko/bloxos/proto/powerhistory"

// A view of window means; it deliberately has no peak. Adding independently
// sampled peaks would invent a simultaneous observation.
type fleetPowerReading struct {
	watts                float64
	samples              int
	source, kind, reason string
}

func fleetPowerReadingFor(bk *powerhistory.Bucket, domain string, expected int) fleetPowerReading {
	if domain == fleetPowerDomainTotal {
		cpu := fleetPowerReadingFor(bk, powerhistory.DomainCPU, expected)
		gpu := fleetPowerReadingFor(bk, fleetPowerDomainGPU, expected)
		for _, r := range []fleetPowerReading{cpu, gpu} {
			if r.reason != "" {
				return r
			}
			if r.kind != fleetPowerKindMeasured {
				return fleetPowerReading{reason: fleetPowerReasonSourceUnverified}
			}
		}
		// Both means must cover this same complete window. Partial independent
		// samples could otherwise cover disjoint portions of the interval.
		if expected <= 0 || cpu.samples != expected || gpu.samples != expected {
			return fleetPowerReading{reason: "incomplete_components"}
		}
		return fleetPowerReading{watts: cpu.watts + gpu.watts, samples: expected,
			source: "cpu:" + cpu.source + "+gpu:unlabelled", kind: fleetPowerKindMeasured}
	}
	stats, source, maxWatts := fleetPowerDomainStats(bk, domain)
	if stats == nil || stats.Samples <= 0 || stats.MeanWatts == nil {
		return fleetPowerReading{reason: fleetPowerReasonAbsent}
	}
	if err := validPowerStats(stats, expected, maxWatts); err != nil {
		return fleetPowerReading{reason: fleetPowerReasonUnreadable}
	}
	return fleetPowerReading{watts: *stats.MeanWatts, samples: stats.Samples,
		source: fleetPowerSourceLabel(domain, source), kind: fleetPowerKindFor(domain, source, stats)}
}
