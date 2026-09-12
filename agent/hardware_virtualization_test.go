//go:build linux

package main

import (
	"encoding/json"
	"testing"

	"github.com/shirou/gopsutil/v4/host"
)

// A KVM HOST and a KVM guest both report VirtualizationSystem "kvm". The role
// is the only thing that tells them apart, and it was being read from
// host.Info() and thrown away — which is how a bare-metal machine running a
// Windows guest came to be recorded, and repeatedly discussed, as a VM.
func TestVirtualizationRoleSurvivesCollection(t *testing.T) {
	for _, tc := range []struct {
		name       string
		info       host.InfoStat
		wantSystem string
		wantRole   string
	}{
		{
			name:       "kvm host",
			info:       host.InfoStat{VirtualizationSystem: "kvm", VirtualizationRole: "host"},
			wantSystem: "kvm",
			wantRole:   "host",
		},
		{
			name:       "kvm guest",
			info:       host.InfoStat{VirtualizationSystem: "kvm", VirtualizationRole: "guest"},
			wantSystem: "kvm",
			wantRole:   "guest",
		},
		{
			// Detected, but the role was not. Reported as unknown rather than
			// guessed: "kvm" alone is precisely the ambiguity being fixed.
			name:       "system without a role",
			info:       host.InfoStat{VirtualizationSystem: "kvm"},
			wantSystem: "kvm",
			wantRole:   "",
		},
		{
			// No system reported. That is absence, not proof of bare metal —
			// and a role with nothing to qualify says nothing on its own, so
			// carrying it would invite reading it as a claim.
			name:     "no system reported",
			info:     host.InfoStat{VirtualizationRole: "host"},
			wantRole: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var hw HardwareInfo
			applyHostInfo(&hw, &tc.info)
			if hw.Virtualization != tc.wantSystem {
				t.Fatalf("virtualization = %q, want %q", hw.Virtualization, tc.wantSystem)
			}
			if hw.VirtualizationRole != tc.wantRole {
				t.Fatalf("virtualization_role = %q, want %q", hw.VirtualizationRole, tc.wantRole)
			}
		})
	}
}

// The field is additive: a hub or dashboard that has never heard of it reads
// the payload exactly as before, and an agent that does not set it sends no
// key at all rather than an empty string that would render as a value.
func TestVirtualizationRoleIsOptionalOnTheWire(t *testing.T) {
	var bare HardwareInfo
	applyHostInfo(&bare, &host.InfoStat{KernelVersion: "6.8.0"})
	encoded, err := json.Marshal(bare)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := decoded["virtualization_role"]; present {
		t.Fatalf("an unset role must not appear on the wire: %s", encoded)
	}

	// And an OLD payload with no role decodes cleanly into the new struct.
	var old HardwareInfo
	if err := json.Unmarshal([]byte(`{"virtualization":"kvm","kernel_version":"5.15.0"}`), &old); err != nil {
		t.Fatalf("decoding an older report must not fail: %v", err)
	}
	if old.Virtualization != "kvm" || old.VirtualizationRole != "" {
		t.Fatalf("old report decoded as %+v", old)
	}
}
