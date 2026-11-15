import { describe, expect, it } from "vitest";
import { answer, helmetView, matchIntent, nextStop } from "./helmet";
import { type MissionState, type Route, type SimState, getState } from "./store";

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
  instructions: [],
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

// One leg of 12 m: 6 m east, then 6 m south. Cells 3 m apart.
const TURN_ROUTE: Route = {
  ...ROUTE,
  path: [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 2, row: 0 },
    { col: 2, row: 1 },
    { col: 2, row: 2 },
  ],
  legs: [{ from: "habitat", to: "2,2", distanceM: 12, energyJ: 1, timeS: 12 }],
  stopTimeS: 0,
  elevationProfile: [0, 3, 6, 9, 12].map((distanceM) => ({ distanceM, elevationM: 0 })),
  instructions: [
    { text: "Head E for 6 m", direction: "E", distanceM: 6, cellIndex: 0 },
    { text: "Head S for 6 m to 2,2", direction: "S", distanceM: 6, cellIndex: 2, warning: "Caution slope (15-20 deg)" },
  ],
};

describe("helmetView", () => {
  it("shows the step the crew is on, with the arrow and the distance left in that step", () => {
    const first = helmetView(stateWith({ route: TURN_ROUTE, crewCell: { col: 1, row: 0 }, elapsedS: 3 }));
    expect(first.mode).toBe("step");
    expect(first.arrowDeg).toBe(90);
    expect(first.headline).toBe("E 3 m");
    expect(first.detail).toBe("Head E for 6 m. Then: Head S for 6 m to 2,2");
    expect(first.warning).toBeNull();

    const second = helmetView(stateWith({ route: TURN_ROUTE, crewCell: { col: 2, row: 1 }, elapsedS: 9 }));
    expect(second.arrowDeg).toBe(180);
    expect(second.headline).toBe("S 3 m");
    expect(second.warning).toBe("Caution slope (15-20 deg)");
  });

  it("shows the recommended action instead of the step during a contingency", () => {
    const contingency = {
      type: "simState",
      scenario: "buddy_injured",
      timeS: 3,
      astronauts: [
        { id: "A", cell: { col: 1, row: 0 }, status: "rescuer", usedJ: 0 },
        { id: "B", cell: { col: 1, row: 0 }, status: "injured", usedJ: 0 },
      ],
      separationM: 0,
      envelope: { type: "envelope", mask: new Uint8Array(0), remainingJ: 0, turnBackAtS: 0 },
      recommendedAction: "return",
      actionPath: [{ col: 1, row: 0 }, { col: 0, row: 0 }],
      actionTargetId: "habitat",
      actionTimeS: 360,
      actionEnergyJ: 1,
      actionDistanceM: 177,
      shelters: [],
      warnings: [],
    } as SimState;
    const view = helmetView(stateWith({ route: TURN_ROUTE, crewCell: { col: 1, row: 0 }, scenario: "buddy_injured", contingency }));
    expect(view.mode).toBe("action");
    expect(view.arrowDeg).toBeNull();
    expect(view.headline).toBe("A carries B to habitat");
    expect(view.detail).toBe("0 h 06 min, 177 m");
  });

  it("radiation and turn-back tiles follow the scenario and the envelope", () => {
    const envelope = { type: "envelope" as const, mask: new Uint8Array(0), remainingJ: 0, turnBackAtS: 100 };
    expect(helmetView(stateWith({ envelope, elapsedS: 200 })).turnBack).toEqual({ text: "NOW", urgent: true });
    expect(helmetView(stateWith({ scenario: "sep_event" })).radiation.alert).toBe(true);
    expect(helmetView(stateWith({ route: null })).mode).toBe("none");
  });
});

describe("voice answers come from engine values only", () => {
  it("parses typical spoken phrases (speech recognition output has no punctuation)", () => {
    expect(matchIntent("when do I have to turn around")).toBe("QUERY_TURN_BACK");
    expect(matchIntent("how far is my partner")).toBe("QUERY_BUDDY");
    expect(matchIntent("is there a solar storm")).toBe("QUERY_RADIATION");
    expect(matchIntent("What's next")).toBe("QUERY_NEXT_STOP");
  });

  it("buddy: SimState.separationM against BUDDY_MAX_SEPARATION_M", () => {
    const sim = { separationM: 181 } as SimState;
    const text = answer("QUERY_BUDDY", stateWith({ sim, params: { BUDDY_MAX_SEPARATION_M: 100 } })).text;
    expect(text).toBe("Buddy B is 181 m away. Above the 100 m limit: close the gap.");
  });

  it("radiation and shelter during a solar particle alert use the simulator's shelter and time", () => {
    const contingency = { scenario: "sep_event", actionTargetId: "rover", actionTimeS: 120 } as SimState;
    const state = stateWith({ scenario: "sep_event", contingency });
    expect(answer("QUERY_SHELTER", state).text).toBe("Solar particle alert: go to rover, 0 h 02 min walk.");
    expect(answer("QUERY_RADIATION", state).text).toContain("Go to rover now, 0 h 02 min walk.");
  });
});
