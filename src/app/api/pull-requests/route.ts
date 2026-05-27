import { NextResponse } from "next/server";

import { ConfigError, loadConfig } from "@/lib/config";
import { fetchHost } from "@/lib/github";
import { applyActivity } from "@/lib/state";
import type { DashboardResponse, HostError, PullRequest, RateLimitInfo } from "@/lib/types";

// Always fresh data — no Next cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      return NextResponse.json({ error: e.message, kind: "config" }, { status: 400 });
    }
    throw e;
  }

  const allPrs: PullRequest[] = [];
  const errors: HostError[] = [];
  const rateLimits: RateLimitInfo[] = [];

  // Hosts are queried in parallel; one failing doesn't break the rest.
  const results = await Promise.allSettled(config.hosts.map((h) => fetchHost(h)));
  results.forEach((result, i) => {
    const host = config.hosts[i];
    if (result.status === "fulfilled") {
      allPrs.push(...result.value.pullRequests);
      if (host.repos.length > 0) rateLimits.push(result.value.rateLimit);
    } else {
      const reason = result.reason;
      errors.push({
        hostLabel: host.label,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });

  // Set the new-activity/attention flags by comparing against the stored state.
  await applyActivity(allPrs);

  // Attention-needing first; then by most recently updated.
  allPrs.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const body: DashboardResponse = {
    pullRequests: allPrs,
    errors,
    rateLimits,
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
