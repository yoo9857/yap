import { describe, expect, it } from "vitest";
import { decideShards, readCpuQuota } from "../src/cluster/capacity.js";

const MiB = 1048576;

describe("decideShards (SHARDS=auto)", () => {
  it("1 core (today's server): the single process, whatever the memory", () => {
    expect(decideShards("auto", { cores: 1, cpuQuota: null, memoryBytes: 768 * MiB }).shards).toBe(1);
    expect(decideShards("auto", { cores: 1, cpuQuota: null, memoryBytes: 0 }).shards).toBe(1);
  });

  it("grows with the server: a shard per core, no config change", () => {
    expect(decideShards("auto", { cores: 2, cpuQuota: null, memoryBytes: 768 * MiB }).shards).toBe(2);
    expect(decideShards("auto", { cores: 4, cpuQuota: null, memoryBytes: 0 }).shards).toBe(4);
    expect(decideShards("auto", { cores: 64, cpuQuota: null, memoryBytes: 0 }).shards).toBe(8);
  });

  it("obeys a docker cpus quota below the host's cores", () => {
    expect(decideShards("auto", { cores: 8, cpuQuota: 0.5, memoryBytes: 0 }).shards).toBe(1);
    expect(decideShards("auto", { cores: 8, cpuQuota: 2.5, memoryBytes: 0 }).shards).toBe(2);
  });

  it("never starts more processes than the memory limit holds (an OOM kills the whole container)", () => {
    // 400 MiB: (400 - 80) / 150 = 2
    expect(decideShards("auto", { cores: 8, cpuQuota: null, memoryBytes: 400 * MiB }).shards).toBe(2);
    expect(decideShards("auto", { cores: 8, cpuQuota: null, memoryBytes: 200 * MiB }).shards).toBe(1);
  });

  it("honours an explicit count, but lowers one the memory cannot hold", () => {
    expect(decideShards("1", { cores: 8, cpuQuota: null, memoryBytes: 0 }).shards).toBe(1);
    expect(decideShards("3", { cores: 1, cpuQuota: null, memoryBytes: 0 }).shards).toBe(3);
    const low = decideShards("6", { cores: 8, cpuQuota: null, memoryBytes: 400 * MiB });
    expect(low.shards).toBe(2);
    expect(low.reason).toMatch(/lowered/);
  });

  it("explains itself for the boot log", () => {
    expect(decideShards("auto", { cores: 1, cpuQuota: null, memoryBytes: 768 * MiB }).reason).toBe("auto: 1 usable core(s), 768 MiB limit → single process");
  });
});

describe("readCpuQuota", () => {
  const files = (map: Record<string, string>) => (p: string) => {
    if (p in map) return map[p]!;
    throw new Error("ENOENT");
  };
  it("reads cgroup v2 cpu.max", () => {
    expect(readCpuQuota(files({ "/sys/fs/cgroup/cpu.max": "150000 100000\n" }))).toBe(1.5);
    expect(readCpuQuota(files({ "/sys/fs/cgroup/cpu.max": "max 100000\n" }))).toBeNull();
  });
  it("falls back to cgroup v1, and to 'unknown' when nothing is readable", () => {
    expect(readCpuQuota(files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" }))).toBe(2);
    expect(readCpuQuota(files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" }))).toBeNull();
    expect(readCpuQuota(files({}))).toBeNull();
    expect(readCpuQuota(files({ "/sys/fs/cgroup/cpu.max": "garbage" }))).toBeNull();
  });
});
