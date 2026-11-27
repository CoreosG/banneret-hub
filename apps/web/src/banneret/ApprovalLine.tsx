import type { BanneretBoardPr } from "@t3tools/contracts";

export function ApprovalLine({
  pr,
  detail = false,
  numbered = false,
}: {
  readonly pr: BanneretBoardPr;
  readonly detail?: boolean;
  readonly numbered?: boolean;
}) {
  const rules = pr.rules;
  const approvals = rules?.approvals;
  const parts: string[] = [];
  if (!approvals) parts.push("Approval rules unavailable");
  else if (detail) {
    if (approvals.required)
      parts.push(`${approvals.required} approval${approvals.required === 1 ? "" : "s"}`);
    if (approvals.codeOwners.required) parts.push("code owners");
    if (approvals.lastPushApproval) parts.push("approval of the latest push");
    if (!parts.length) parts.push("no approval needed");
    if (approvals.stale) parts.push("new commits dismiss stale approvals");
  } else {
    const remaining = approvals.required - approvals.have;
    if (remaining > 0) parts.push(`Needs ${remaining} more approval${remaining === 1 ? "" : "s"}`);
    if (approvals.codeOwners.required && !approvals.codeOwners.satisfiedBy?.length)
      parts.push(remaining > 0 ? "code owner" : "Needs a code owner");
    if (approvals.lastPushApproval && !approvals.lastPushSatisfied)
      parts.push("Needs approval of the latest push");
    if (!parts.length)
      parts.push(
        approvals.required || approvals.codeOwners.required || approvals.lastPushApproval
          ? "Approval requirements met"
          : "No approval needed",
      );
  }
  return (
    <span className="block text-xs">
      {numbered && `#${pr.number} · `}
      {detail && rules && `Branch rule on ${rules.baseBranch}: `}
      {parts.join(detail ? ", " : " · ")}
      {pr.state === "open" && rules?.youCanApprove && " · You can approve"}
      {detail && approvals?.codeOwners.required && approvals.codeOwners.owners.length > 0 && (
        <span className="block">Code owners: {approvals.codeOwners.owners.join(", ")}</span>
      )}
      {detail && rules && rules.canApprove.length > 0 && (
        <span className="block">
          Can approve: {rules.canApprove.map((person) => person.login).join(", ")}
        </span>
      )}
    </span>
  );
}
