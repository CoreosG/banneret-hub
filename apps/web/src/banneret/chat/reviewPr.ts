import type { AskPr, BanneretBoardPr } from "@t3tools/contracts";

export function reviewRepository(pr: BanneretBoardPr) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i.exec(pr.url);
  return match && Number(match[2]) === pr.number ? match[1] : undefined;
}
export function matchesReview(pr: BanneretBoardPr, ask: AskPr | undefined) {
  return (
    ask !== undefined &&
    ask.number === pr.number &&
    reviewRepository(pr)?.toLowerCase() === ask.repo.toLowerCase()
  );
}
