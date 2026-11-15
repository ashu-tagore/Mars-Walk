import { describe, expect, it } from "vitest";
import { answer, matchIntent, nextStop } from "./helmet";
import { type MissionState, type Route, getState } from "./store";

// Example phrases from docs/data-contract.md, section 5.
describe("matchIntent", () => {
  it("maps each contract example phrase to its intent", () => {
    expect(matchIntent("how long until turn back")).toBe("QUERY_TURN_BACK");
    expect(matchIntent("where is the next stop")).toBe("QUERY_NEXT_STOP");
    expect(matchIntent("where is my buddy")).toBe("QUERY_BUDDY");
    expect(matchIntent("nearest shelter")).toBe("QUERY_SHELTER");
    expect(matchIntent("radiation status")).toBe("QUERY_RADIATION");
  });

  it("ignores case and punctuation", () => {
    expect(matchIntent("  Nearest SHELTER?! ")).toBe("QUERY_SHELTER");
  });

  it("returns null for an unknown or empty command", () => {
    expect(matchIntent("open the pod bay doors")).toBeNull();
    expect(matchIntent("   ")).toBeNull();
  });
});

// Two legs: habitat -> s1 (600 s), 1200 s at s1, s1 -> habitat (900 s).
const ROUTE: Route = {
  type: "route",
  path: [],
  legs: [
    { from: "habitat", to: "s1", distanceM: 500, energyJ: 1, timeS: 600 },
    { from: "s1", to: "habitat", distanceM: 700, energyJ: 1, timeS: 900 },
  ],
  stopTimeS: 1200,
  stopEnergyJ: 0,
  totalEnergyJ: 2,
  totalTimeS: 2700,
  elevationProfile: [],
  verdict: "GO",
  reasons: [],
};

function stateWith(partial: Partial<MissionState>): MissionState {
  return { ...getState(), ...partial };
}

describe("nextStop", () => {
  it("walks the leg times and the time at each stop", () => {
    expect(nextStop(stateWith({ route: ROUTE, elapsedS: 0 })).stopId).toBe("s1");
    expect(nextStop(stateWith({ route: ROUTE, elapsedS: 0 })).answer.text).toContain("arrive at EVA time 0:10");
    expect(nextStop(stateWith({ route: ROUTE, elapsedS: 700 })).answer.text).toBe("At s1 until EVA time 0:30. Then habitat.");
    expect(nextStop(stateWith({ route: ROUTE, elapsedS: 1900 })).answer.text).toContain("Last leg to habitat");
    expect(nextStop(stateWith({ route: ROUTE, elapsedS: 2800 })).stopId).toBeNull();
  });

  it("says when there is no route", () => {
    expect(nextStop(stateWith({ route: null })).answer.text).toBe("No route planned.");
  });
});

describe("answer", () => {
  it("turn back: from the envelope, or now when the time has passed", () => {
    const envelope = { type: "envelope" as const, mask: new Uint8Array(0), remainingJ: 0, turnBackAtS: 3600 };
    expect(answer("QUERY_TURN_BACK", stateWith({ envelope, elapsedS: 0 })).text).toBe("Turn back in 1 h 00 min, at EVA time 1:00.");
    expect(answer("QUERY_TURN_BACK", stateWith({ envelope, elapsedS: 3600 })).text).toBe("Turn back now. Return to the habitat.");
  });

  it("shelter: the fastest option, or the simulator's choice during a solar particle alert", () => {
    const shelterTimes = {
      type: "shelterTimes" as const,
      options: [{ shelterId: "rover", kind: "full" as const, timeS: 720, path: [] }],
    };
    expect(answer("QUERY_SHELTER", stateWith({ shelterTimes })).text).toBe("Nearest full shelter: rover, 0 h 12 min walk.");
  });

  it("is deterministic", () => {
    const state = stateWith({ route: ROUTE, elapsedS: 700 });
    expect(answer("QUERY_NEXT_STOP", state)).toEqual(answer("QUERY_NEXT_STOP", state));
  });
});
