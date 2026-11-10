import type { CheckItem } from "../../../shared/types";
import { checkDisplayName, type CheckBadgeItem } from "../../../shared/check-groups";
import { checkStateClasses, checkStateIcon, cn } from "../format";

/** Compact badge for a single CI check; clickable when a link is present. */
export function CheckBadge({ check }: { check: CheckItem }) {
  const className = cn(
    "inline-flex max-w-[15rem] items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
    checkStateClasses(check.state),
    check.url && "hover:brightness-125",
  );
  const content = (
    <>
      <span aria-hidden>{checkStateIcon(check.state)}</span>
      <span className="truncate" title={check.name}>
        {checkDisplayName(check.name)}
      </span>
    </>
  );

  if (check.url) {
    return (
      <a href={check.url} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return <span className={className}>{content}</span>;
}

/** Several checks in one state as one badge; hover names them, a click opens the PR's checks. */
export function CheckGroupBadge({ item, url }: { item: Extract<CheckBadgeItem, { kind: "group" }>; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={item.names.join("\n")}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium hover:brightness-125",
        checkStateClasses(item.state),
      )}
    >
      <span aria-hidden>{checkStateIcon(item.state)}</span>
      <span>{item.label}</span>
    </a>
  );
}
