import type { CheckItem } from "../../../shared/types";
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
        {check.name}
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
