import { describe, it, expect } from "vitest";
import { scoreEvent } from "../../src/analysis/event.js";
import { sigmoid } from "../../src/analysis/indicators.js";
import { makeContext, makeEvents, testConfig } from "../helpers/contextFactory.js";
import type { EventSignals } from "../../src/core/types.js";

const cfg = testConfig();
const score = (overrides: Partial<EventSignals>) => scoreEvent(makeContext({ events: makeEvents(overrides) }), cfg);

const quiet: Partial<EventSignals> = {
  newPoolWithin24h: false,
  graduatedFromLaunchpad: false,
  enteredTrendingList: false,
  volumeZScore1h: 0,
  volumeSpike5m: false,
  llmEventScore: null,
  llmEventReason: null,
};
const loud: Partial<EventSignals> = {
  newPoolWithin24h: true,
  graduatedFromLaunchpad: true,
  enteredTrendingList: true,
  volumeZScore1h: 6,
  volumeSpike5m: true,
  llmEventScore: null,
  llmEventReason: null,
};

describe("scoreEvent", () => {
  it("scores a quiet token near zero (only the z-score sigmoid floor remains)", () => {
    const r = score(quiet);
    expect(r.score).toBeCloseTo(0.25 * sigmoid(-1), 6);
    expect(r.reasons).toContain("1h volume z-score 0 (sigmoid centred at 1) -> 0.27");
  });

  it("scores a loud token near one", () => {
    expect(score(loud).score).toBeGreaterThan(0.99);
  });

  it.each([
    { name: "graduated", flag: "graduatedFromLaunchpad" as const, weight: 0.2 },
    { name: "new pool", flag: "newPoolWithin24h" as const, weight: 0.15 },
    { name: "entered trending", flag: "enteredTrendingList" as const, weight: 0.2 },
    { name: "5m spike", flag: "volumeSpike5m" as const, weight: 0.2 },
  ])("$name alone adds its weight", ({ flag, weight }) => {
    const base = score(quiet).score;
    const r = score({ ...quiet, [flag]: true });
    expect(r.score - base).toBeCloseTo(weight, 6);
  });

  it("new pool alone is positive but not enough on its own", () => {
    expect(score({ ...quiet, newPoolWithin24h: true }).score).toBeLessThan(0.3);
  });

  it.each([
    { z: -3, e: sigmoid(-4) },
    { z: 1, e: 0.5 },
    { z: 3, e: sigmoid(2) },
    { z: 10, e: sigmoid(9) },
  ])("maps volume z-score $z through a sigmoid centred at 1", ({ z, e }) => {
    const base = score(quiet).score;
    const r = score({ ...quiet, volumeZScore1h: z });
    expect(r.score - base).toBeCloseTo(0.25 * (e - sigmoid(-1)), 6);
  });

  it("gives the LLM event score 40% of the lens when present", () => {
    const llmOnly = score({ ...quiet, volumeZScore1h: -100, llmEventScore: 1, llmEventReason: "fresh listing" });
    expect(llmOnly.score).toBeCloseTo(0.4, 6);
    expect(llmOnly.reasons).toContain("LLM event: fresh listing -> 1");
    const heuristicsOnly = score({ ...loud, llmEventScore: 0, llmEventReason: "nothing" });
    expect(heuristicsOnly.score).toBeCloseTo(0.6 * score(loud).score, 6);
    expect(score({}).reasons).toContain("LLM event score absent; heuristic components renormalised");
  });
});
