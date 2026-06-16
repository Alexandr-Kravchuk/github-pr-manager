/**
 * Login screen. One "Connect" button per configured host that has an OAuth
 * provider; clicking it kicks off the web-redirect flow. Rendered server-side
 * so it can read the host list directly from config.
 */

import { listHosts } from "@/lib/config";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ERROR_MESSAGES: Record<string, string> = {
  bad_state: "Login could not be verified (the request expired or was tampered with). Try again.",
  exchange_failed: "GitHub rejected the authorization. Check the OAuth App configuration.",
  provider_misconfigured: "This provider is missing its client id/secret on the server.",
  unknown_provider: "That provider is not configured.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  let hosts: { label: string; oauthProvider?: string }[] = [];
  let configError: string | null = null;
  try {
    hosts = listHosts().filter((h) => h.oauthProvider);
  } catch (e) {
    configError = (e as Error).message;
  }

  const session = await getSession();
  const connected = new Set(Object.keys(session?.providers ?? {}));

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/60 p-8">
        <h1 className="text-lg font-semibold text-zinc-100">Pull Request Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">Connect an account to view your pull requests.</p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-600/40 bg-red-950/40 p-3 text-sm text-red-200">
            {ERROR_MESSAGES[error] ?? "Login failed. Please try again."}
          </div>
        )}

        {configError && (
          <div className="mt-4 rounded-lg border border-amber-600/40 bg-amber-950/40 p-3 text-sm text-amber-200">
            {configError}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2">
          {hosts.map((h) => {
            const isConnected = connected.has(h.oauthProvider!);
            return (
              <a
                key={h.oauthProvider}
                href={`/api/auth/login/${h.oauthProvider}`}
                className="flex items-center justify-between rounded-md border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-800"
              >
                <span>{isConnected ? `Reconnect ${h.label}` : `Connect ${h.label}`}</span>
                {isConnected && <span className="text-xs text-emerald-400">● connected</span>}
              </a>
            );
          })}
          {hosts.length === 0 && !configError && (
            <p className="text-sm text-zinc-500">No OAuth-enabled hosts are configured.</p>
          )}
        </div>

        {connected.size > 0 && (
          <a href="/" className="mt-6 block text-center text-sm text-sky-400 hover:underline">
            Continue to dashboard →
          </a>
        )}
      </div>
    </div>
  );
}
