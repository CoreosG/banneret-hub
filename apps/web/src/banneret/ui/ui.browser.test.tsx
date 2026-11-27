import "~/index.css";

import { AlertTriangleIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { LeaseChip, ReasonChip } from "./Chips";
import { FactsGrid } from "./FactsGrid";
import { HealthTile } from "./HealthTile";
import { MapItemCard } from "./MapItemCard";
import { PageHeader, SummaryFigure } from "./PageHeader";
import { QuietLine } from "./QuietLine";
import { RelativeTime } from "./RelativeTime";
import { Section, SectionEmpty, SectionRow } from "./Section";
import { StatusLegend } from "./StatusLegend";
import { StatusPill } from "./StatusPill";
import { TaskCard } from "./TaskCard";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

/** Composites `layers` (CSS colours, bottom first) on a 1x1 canvas and returns sRGB bytes. */
function paint(...layers: ReadonlyArray<string>): readonly [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  for (const layer of layers) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function luminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: readonly [number, number, number], b: readonly [number, number, number]) {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// tokens.md "Resolved values and contrast", reproduced by contrast.py.
const EXPECTED: Record<string, { readonly dark: number; readonly light: number }> = {
  checked: { dark: 7.7, light: 5.0 },
  built: { dark: 6.0, light: 6.2 },
  needs_you: { dark: 8.4, light: 4.8 },
  sent_back: { dark: 5.5, light: 5.7 },
  planned: { dark: 5.7, light: 7.0 },
  ruled_dead: { dark: 7.3, light: 7.7 },
};

describe("StatusPill", () => {
  it.each(["light", "dark"] as const)("status text meets AA on a card in %s", async (theme) => {
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    try {
      await using screen = await render(
        <div data-testid="card" className="flex flex-col gap-2 bg-card p-3">
          {Object.keys(EXPECTED).map((status) => (
            <StatusPill key={status} status={status} />
          ))}
        </div>,
      );
      const card = getComputedStyle(screen.getByTestId("card").element()).backgroundColor;
      const pills = screen.container.querySelectorAll<HTMLElement>("[data-slot=status-pill]");
      expect(pills).toHaveLength(Object.keys(EXPECTED).length);
      for (const pill of pills) {
        const style = getComputedStyle(pill);
        const ratio = contrast(paint(style.color), paint(card, style.backgroundColor));
        const expected = EXPECTED[pill.dataset.status ?? ""]?.[theme] ?? Number.NaN;
        expect.soft(ratio, `${pill.dataset.status} in ${theme}`).toBeGreaterThanOrEqual(4.5);
        expect
          .soft(Math.abs(ratio - expected), `${pill.dataset.status} in ${theme}`)
          .toBeLessThan(0.3);
      }
    } finally {
      root.classList.toggle("dark", wasDark);
    }
  });

  it("shows why in its tooltip, not on the pill, and names a blocker", async () => {
    await using screen = await render(
      <StatusPill status="blocked" blockedBy="Sign-in page" why="Waits on the sign-in page" />,
    );
    await expect.element(screen.getByText("Blocked by Sign-in page")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Waits on");
    await userEvent.hover(screen.getByText("Blocked by Sign-in page"));
    await expect.element(page.getByText("Waits on the sign-in page")).toBeVisible();
  });
});

describe("TaskCard", () => {
  it("opens from the keyboard, and only attention statuses get the accent bar", async () => {
    const onOpen = vi.fn();
    await using screen = await render(
      <div className="flex w-60 flex-col gap-2">
        <TaskCard
          title="Sign-in page"
          status="needs_you"
          refLabel="acme/web#332"
          onOpen={onOpen}
          footer="PR #12 open"
          lease={
            <LeaseChip
              holder="ada"
              state="active"
              lastSignalAt={new Date(NOW).toISOString()}
              nowMs={NOW}
            />
          }
        />
        <TaskCard title="Settings" status="built" />
      </div>,
    );
    const open = screen.getByRole("button", { name: /Sign-in page/ });
    await userEvent.keyboard("{Tab}");
    await expect.element(open).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    const bars = screen.container.querySelectorAll("[data-slot=accent-bar]");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.closest("[data-slot=task-card]")?.getAttribute("data-status")).toBe(
      "needs_you",
    );
    expect(screen.getByRole("button").elements()).toHaveLength(1);
  });
});

describe("LeaseChip", () => {
  it("wraps in a narrow column instead of truncating", async () => {
    await using screen = await render(
      <div className="flex w-32 flex-col">
        <LeaseChip
          holder="grace-hopper-example"
          state="conflict"
          lastSignalAt={new Date(NOW).toISOString()}
          nowMs={NOW}
        />
      </div>,
    );
    const chip = screen.container.querySelector<HTMLElement>("[data-slot=lease-chip]");
    if (chip === null) throw new Error("no chip");
    expect(chip.textContent).toContain("conflict, two people claim this");
    expect(chip.getBoundingClientRect().height).toBeGreaterThan(20);
    expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
  });
});

describe("MapItemCard", () => {
  it("opens when on the board; without a task it is dashed and not a control", async () => {
    const onOpen = vi.fn();
    await using screen = await render(
      <div className="flex flex-col gap-2">
        <MapItemCard title="Sign-in page" status="built" number={332} onOpen={onOpen} />
        <MapItemCard title="Billing" status="planned" />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Sign-in page/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").elements()).toHaveLength(1);
    const offBoard = screen
      .getByText("Billing")
      .element()
      .closest<HTMLElement>("[data-slot=map-item]");
    expect(offBoard && getComputedStyle(offBoard).borderStyle).toBe("dashed");
  });
});

describe("RelativeTime", () => {
  it("reads in English with the exact English time in its tooltip", async () => {
    await using screen = await render(
      <RelativeTime at="2026-11-25T11:00:00.000Z" nowMs={NOW} prefix="Seen" />,
    );
    await expect.element(screen.getByText("Seen 2 d ago")).toBeVisible();
    await userEvent.hover(screen.getByText("Seen 2 d ago"));
    await expect.element(page.getByText(/^Nov 2[45], 2026, /)).toBeVisible();
  });
});

describe("StatusLegend", () => {
  it("counts the agent-at-work chip and dims it at zero, like a status", async () => {
    await using screen = await render(
      <>
        <StatusLegend counts={{ needs_you: 1, planned: 0 }} atWorkCount={2} />
        <StatusLegend counts={{ needs_you: 1 }} atWorkCount={0} />
      </>,
    );
    const [busy, idle] = screen.container.querySelectorAll('[data-slot="legend-at-work"]');
    expect(busy?.querySelector("[data-count]")?.textContent).toBe("2");
    expect(busy?.className).not.toContain("opacity-45");
    expect(idle?.querySelector("[data-count]")?.textContent).toBe("0");
    expect(idle?.className).toContain("opacity-45");
  });
});

describe("page pieces", () => {
  it("compose into a page with header, legend, section rows, empty states, health and facts", async () => {
    const onSelect = vi.fn();
    await using screen = await render(
      <div className="flex w-200 flex-col gap-4">
        <PageHeader
          title="Board"
          summary={
            <>
              <SummaryFigure>3</SummaryFigure> items need you
            </>
          }
        >
          <button type="button">Mine</button>
        </PageHeader>
        <StatusLegend counts={{ needs_you: 3, planned: 0 }} />
        <Section title="Stuck" icon={AlertTriangleIcon} count={1} attention>
          <SectionRow onSelect={onSelect}>
            <ReasonChip reason="dev_red" /> Release train
          </SectionRow>
        </Section>
        <Section title="Shipped" count={0}>
          <SectionEmpty
            icon={AlertTriangleIcon}
            title="Nothing shipped yet"
            description="Merged work appears here."
          />
        </Section>
        <QuietLine fact="Nothing stuck." hint="Stuck items appear here." />
        <HealthTile
          label="Dev branch"
          state="good"
          observedAt="2026-11-27T09:00:00.000Z"
          nowMs={NOW}
        />
        <FactsGrid
          facts={[
            { label: "Status", value: "Built" },
            { label: "Opened", value: undefined },
          ]}
        />
      </div>,
    );
    await expect.element(screen.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Release train/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const zero = screen.container.querySelector<HTMLElement>("li[data-status=planned]");
    expect(zero && getComputedStyle(zero).opacity).toBe("0.45");
    expect(screen.container.querySelector("[data-slot=attention-bar]")).not.toBeNull();
    await expect.element(screen.getByText("Seen 3 h ago")).toBeVisible();
    expect(screen.container.querySelectorAll("dt")).toHaveLength(1);
  });
});
