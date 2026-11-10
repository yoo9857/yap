import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  balanceAdvice,
  balanceLines,
  faceArc,
  faceOffset,
  facePoint,
  guideAim,
  guideHint,
  scalePose,
  SHAFT_TURN,
  thrustGuides,
  thrustMisses,
  turnBasis,
  turnSweep,
} from "../src/craft/machines/balance.js";
import { addPart, DIRECTIONS, preset, type Blueprint, type Cell } from "../src/craft/machines/blueprint.js";

const part = (
  kind: Blueprint["parts"][number]["kind"],
  cell: Cell,
  direction = 0,
): Blueprint["parts"][number] => ({
  kind,
  cell,
  direction,
});

const machine = (parts: Blueprint["parts"], name = "test"): Blueprint => ({
  version: 1,
  name,
  parts,
});

describe("centre of mass for the workshop", () => {
  it("keeps balance advice unchanged when the whole machine is moved", () => {
    for (const kind of ["rover", "plane", "ship"] as const) {
      const blueprint = preset(kind), before = balanceAdvice(blueprint);
      for (const part of blueprint.parts) {
        part.cell[0] += 7;
        part.cell[1] += 3;
        part.cell[2] -= 5;
      }
      const after = balanceAdvice(blueprint);
      expect(after.side).toBe(before.side);
      expect(after.fore).toBe(before.fore);
      expect(after.height).toBe(before.height);
      expect(after.stance).toBe(before.stance);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.z).toBeCloseTo(before.z);
      expect(after.rise).toBeCloseTo(before.rise);
    }
  });
  it("keeps the example rover low and in the middle of its wheels", () => {
    const advice = balanceAdvice(preset("rover"));
    expect(advice.side).toBe("center");
    expect(advice.fore).toBe("center");
    expect(advice.height).toBe("low");
    expect(advice.stance).toBe("steady");
    expect(advice.tone).toBe("good");
    expect(balanceLines(advice).summary).toContain("가운데");
    const pose = scalePose(advice);
    expect(pose.roll).toBe(0);
    expect(pose.pitch).toBe(0);
    expect(pose.lift).toBe(0);
    expect(pose.slideX).toBe(0);
    expect(pose.slideZ).toBe(0);
  });

  it("keeps the example plane and ship from a false tip warning", () => {
    for (const kind of ["plane", "ship"] as const) {
      const advice = balanceAdvice(preset(kind));
      expect(advice.stance).toBe("none");
      expect(advice.side).toBe("center");
      expect(advice.tone).not.toBe("bad");
    }
  });

  it("says a weight on the right leans right, and tells you to balance the other side", () => {
    const rover = preset("rover");
    addPart(rover, { kind: "ballast", cell: [4, 0, 0], direction: 0 });
    const advice = balanceAdvice(rover);
    expect(advice.side).toBe("right");
    expect(advice.x).toBeGreaterThan(0.35);
    expect(advice.tone).toBe("warn");
    expect(balanceLines(advice).hint).toContain("왼쪽");
    const pose = scalePose(advice);
    expect(pose.roll).toBeGreaterThanOrEqual(20);
    expect(pose.slideX).toBeGreaterThan(0.5);
  });

  it("says the weight has left the wheels when it hangs past them", () => {
    const advice = balanceAdvice({
      version: 1,
      name: "tip",
      parts: [
        part("cockpit", [0, 1, 0]),
        part("wheel", [-1, 0, 1]),
        part("wheel", [-1, 0, -1]),
        part("wheel", [1, 0, 1]),
        part("wheel", [1, 0, -1]),
        part("ballast", [4, 0, 0]),
      ],
    });
    expect(advice.stance).toBe("outside");
    expect(advice.tone).toBe("bad");
    expect(balanceLines(advice).summary).toContain("바퀴 밖");
  });

  it("calls a stack of weights high", () => {
    const advice = balanceAdvice({
      version: 1,
      name: "tower",
      parts: [
        part("cockpit", [0, 0, 0]),
        part("wheel", [-1, 0, 1]),
        part("wheel", [1, 0, 1]),
        part("wheel", [-1, 0, -1]),
        part("wheel", [1, 0, -1]),
        part("ballast", [0, 3, 0]),
        part("ballast", [0, 4, 0]),
      ],
    });
    expect(advice.height).toBe("high");
    expect(advice.rise).toBeGreaterThan(1.05);
    expect(balanceLines(advice).hint).toContain("아래");
    expect(scalePose(advice).lift).toBeGreaterThan(0.4);
    expect(scalePose(advice).roll).toBe(0);
  });

  it("is safe with no parts", () => {
    const advice = balanceAdvice({ version: 1, name: "empty", parts: [] });
    expect(advice.tone).toBe("good");
    expect(advice.plotX).toBe(0);
    expect(advice.plotY).toBe(0);
    const thrust = thrustGuides({ version: 1, name: "empty", parts: [] });
    expect(thrust.vertical.tone).toBe("empty");
    expect(thrust.side.tone).toBe("empty");
    expect(thrust.fore.tone).toBe("empty");
    expect(thrustMisses({ version: 1, name: "empty", parts: [] })).toEqual([]);
  });
});

describe("thrust lines through the centre of mass", () => {
  it("points the guide shafts along the cell axes", () => {
    const up = new THREE.Vector3(0, 1, 0);
    const right = up.clone().applyEuler(new THREE.Euler(SHAFT_TURN.side.x, SHAFT_TURN.side.y, SHAFT_TURN.side.z));
    expect(right.x).toBeCloseTo(1);
    expect(right.y).toBeCloseTo(0);
    expect(right.z).toBeCloseTo(0);
    const front = up.clone().applyEuler(new THREE.Euler(SHAFT_TURN.fore.x, SHAFT_TURN.fore.y, SHAFT_TURN.fore.z));
    expect(front.x).toBeCloseTo(0);
    expect(front.y).toBeCloseTo(0);
    expect(front.z).toBeCloseTo(1);
    expect(DIRECTIONS[0]!.vector).toEqual([0, 1, 0]);
    expect(DIRECTIONS[5]!.vector).toEqual([0, -1, 0]);
    expect(DIRECTIONS[3]!.vector).toEqual([1, 0, 0]);
    expect(DIRECTIONS[4]!.vector).toEqual([-1, 0, 0]);
    expect(DIRECTIONS[1]!.vector).toEqual([0, 0, 1]);
    expect(DIRECTIONS[2]!.vector).toEqual([0, 0, -1]);
  });

  it("reads the rover as having no push, and the plane and ship as lined up", () => {
    const rover = thrustGuides(preset("rover"));
    expect(rover.vertical.present).toBe(false);
    expect(rover.side.tone).toBe("empty");
    expect(rover.fore.tone).toBe("empty");
    expect(guideHint(balanceAdvice(preset("rover")), rover)).toContain("같은 색");

    const plane = thrustGuides(preset("plane"));
    expect(plane.vertical.tone).toBe("good");
    expect(plane.vertical.miss).toBeLessThan(0.05);
    expect(plane.vertical.armX).toBeCloseTo(0, 1);
    expect(plane.vertical.armY).toBeCloseTo(0, 1);
    expect(plane.vertical.armZ).toBeCloseTo(0, 1);
    expect(plane.vertical.sign).toBe(1);
    expect(turnSweep(plane.vertical.miss, plane.vertical.spin)).toBe(0);
    expect(plane.vertical.status).toContain("곧게");
    expect(plane.side.tone).toBe("empty");

    const ship = thrustGuides(preset("ship"));
    expect(ship.vertical.miss).toBeLessThan(0.35);
    expect(ship.vertical.tone).toBe("good");
    expect(ship.fore.present).toBe(true);
    expect(ship.fore.miss).toBeLessThan(0.35);
    expect(ship.fore.tone).toBe("good");
  });

  it("says an up thruster beside the seat lifts from the right", () => {
    const blueprint = machine([part("cockpit", [0, 0, 0]), part("thruster", [2, 0, 0])]);
    const thrust = thrustGuides(blueprint);
    expect(thrust.vertical.lean).toBe("right");
    expect(thrust.vertical.miss).toBeCloseTo(4 / 3, 2);
    expect(thrust.vertical.armX).toBeCloseTo(4 / 3, 1);
    expect(thrust.vertical.armY).toBeCloseTo(0, 1);
    expect(thrust.vertical.armZ).toBeCloseTo(0, 1);
    expect(thrust.vertical.sign).toBe(1);
    expect(thrust.vertical.turnZ).toBeGreaterThan(0.9);
    expect(Math.abs(thrust.vertical.turnX)).toBeLessThan(0.1);
    expect(Math.abs(thrust.vertical.turnY)).toBeLessThan(0.1);
    expect(turnSweep(thrust.vertical.miss, false)).toBeGreaterThan(0.5);
    expect(faceOffset(thrust.vertical.armX)).toBeGreaterThan(0.5);
    expect(faceOffset(thrust.vertical.armX)).toBeLessThanOrEqual(1);
    expect(thrust.vertical.tone).toBe("bad");
    expect(thrust.vertical.status).toContain("오른쪽에서");
    expect(thrust.vertical.hint).toContain("노란");
    expect(guideHint(balanceAdvice(blueprint), thrust)).toContain("노란");
    const [miss] = thrustMisses(blueprint);
    expect(miss?.axis).toBe("vertical");
    expect(miss?.to[0]).toBeCloseTo(0);
    expect(miss?.to[2]).toBeCloseTo(0);
  });

  it("treats a balloon as an upward push", () => {
    const thrust = thrustGuides(machine([part("cockpit", [0, 0, 0]), part("balloon", [2, 0, 0])]));
    expect(thrust.vertical.lean).toBe("right");
    expect(thrust.vertical.tone).toBe("bad");
    expect(thrust.side.present).toBe(false);
  });

  it("does not call a downward thruster weak just because it cannot hover", () => {
    const thrust = thrustGuides(machine([part("cockpit", [0, 0, 0]), part("thruster", [0, 1, 0], 5)]));
    expect(thrust.liftRatio).toBe(0);
    expect(thrust.vertical.tone).toBe("good");
    expect(thrust.vertical.sign).toBe(-1);
    expect(turnSweep(thrust.vertical.miss, false)).toBe(0);
    expect(thrust.vertical.status).toContain("내려");
    expect(thrust.vertical.status).not.toContain("약해");
  });

  it("warns when the upward push is straight but too light", () => {
    const blueprint = machine([
      part("cockpit", [0, 0, 0]),
      part("ballast", [0, -1, 0]),
      part("thruster", [0, 1, 0]),
    ]);
    const thrust = thrustGuides(blueprint);
    expect(thrust.vertical.miss).toBeLessThan(0.05);
    expect(thrust.vertical.tone).toBe("warn");
    expect(thrust.vertical.status).toContain("약해");
    expect(guideHint(balanceAdvice(blueprint), thrust)).toContain("추진기");
  });

  it("says opposite side thrusters cancel, and a separated pair spins", () => {
    const cancel = thrustGuides(
      machine([
        part("cockpit", [0, 0, 0]),
        part("thruster", [-2, 0, 0], 4),
        part("thruster", [2, 0, 0], 3),
      ]),
    );
    expect(cancel.side.cancel).toBe(true);
    expect(cancel.side.spin).toBe(false);
    expect(cancel.side.tone).toBe("bad");
    expect(cancel.side.status).toContain("왼쪽과 오른쪽");
    expect(cancel.side.status).not.toContain("돌아");

    const spin = thrustGuides(
      machine([
        part("cockpit", [0, 0, 0]),
        part("thruster", [0, 0, 1], 4),
        part("thruster", [0, 0, -1], 3),
      ]),
    );
    expect(spin.side.cancel).toBe(true);
    expect(spin.side.spin).toBe(true);
    expect(spin.side.sign).toBe(0);
    expect(spin.side.turnY).toBeLessThan(-0.9);
    expect(turnSweep(spin.side.miss, true)).toBeGreaterThan(2);
    expect(spin.side.status).toContain("돌아");
  });

  it("shows a sideways push above the centre, which a flat plot would hide", () => {
    const thrust = thrustGuides(machine([part("cockpit", [0, 0, 0]), part("thruster", [0, 2, 0], 3)]));
    expect(thrust.side.sign).toBe(1);
    expect(thrust.side.armX).toBeCloseTo(0, 1);
    expect(thrust.side.armZ).toBeCloseTo(0, 1);
    expect(thrust.side.armY).toBeCloseTo(4 / 3, 1);
    expect(thrust.side.miss).toBeGreaterThan(0.35);
    expect(thrust.side.turnZ).toBeLessThan(-0.9);
  });

  it("names the way a part in hand points", () => {
    expect(guideAim("thruster", 0)).toEqual({ id: "vertical", sign: 1 });
    expect(guideAim("thruster", 5)).toEqual({ id: "vertical", sign: -1 });
    expect(guideAim("thruster", 1)).toEqual({ id: "fore", sign: 1 });
    expect(guideAim("thruster", 2)).toEqual({ id: "fore", sign: -1 });
    expect(guideAim("thruster", 3)).toEqual({ id: "side", sign: 1 });
    expect(guideAim("thruster", 4)).toEqual({ id: "side", sign: -1 });
    expect(guideAim("balloon", 0)).toEqual({ id: "vertical", sign: 1 });
    expect(guideAim("frame", 3).id).toBeNull();
  });

  it("draws the round guide with front down-left, right down-right, and up toward the top", () => {
    const origin = facePoint(0, 0, 0);
    expect(facePoint(0, 1, 0).y).toBeLessThan(origin.y - 10);
    expect(facePoint(1, 0, 0).x).toBeGreaterThan(origin.x + 10);
    expect(facePoint(0, 0, 1).x).toBeLessThan(origin.x - 10);
    expect(facePoint(0, 0, 1).y).toBeGreaterThan(origin.y + 5);
    expect(faceOffset(0.35)).toBeGreaterThan(0);
  });

  it("curls a positive roll upward from the right, matching the torus", () => {
    const basis = turnBasis(0, 0, 1);
    expect(basis?.x[0]).toBeCloseTo(1);
    expect(basis?.y[1]).toBeCloseTo(1);
    expect(basis?.z[2]).toBeCloseTo(1);
    const arc = faceArc(0, 0, 0, 0, 0, 1, Math.PI / 2, 1, 8);
    const origin = facePoint(0, 0, 0);
    expect(arc[0]!.x).toBeGreaterThan(origin.x + 8);
    expect(arc[arc.length - 1]!.y).toBeLessThan(origin.y - 8);
    const geometry = new THREE.TorusGeometry(1, 0.02, 4, 12, Math.PI / 2);
    const position = geometry.getAttribute("position");
    let maxY = -Infinity;
    let sawStart = false;
    for (let i = 0; i < position.count; i++) {
      if (position.getX(i) > 0.85 && Math.abs(position.getY(i)) < 0.2) sawStart = true;
      maxY = Math.max(maxY, position.getY(i));
    }
    geometry.dispose();
    expect(sawStart).toBe(true);
    expect(maxY).toBeGreaterThan(0.85);
  });

  it("calls a forward thruster on the centre line straight", () => {
    const thrust = thrustGuides(machine([part("cockpit", [0, 0, 0]), part("thruster", [0, 0, 3], 1)]));
    expect(thrust.fore.tone).toBe("good");
    expect(thrust.fore.miss).toBeLessThan(0.05);
    expect(thrust.fore.status).toContain("곧게");
  });

  it("says Shift fires every non-up thruster when more than one boost is fitted", () => {
    const blueprint = machine([
      part("cockpit", [0, 0, 0]),
      part("thruster", [0, 2, 0], 3),
      part("thruster", [0, 0, 2], 1),
    ]);
    const thrust = thrustGuides(blueprint);
    expect(thrust.side.tone).toBe("bad");
    expect(thrust.boostGroups).toBeGreaterThan(1);
    const hint = guideHint(balanceAdvice(blueprint), thrust);
    expect(hint).toContain("빨간");
    expect(hint).toContain("Shift");
  });

  it("keeps a tip warning ahead of a crooked thruster", () => {
    const blueprint = machine([
      part("cockpit", [0, 0, 0]),
      part("wheel", [-1, 0, 1]),
      part("wheel", [1, 0, 1]),
      part("wheel", [-1, 0, -1]),
      part("wheel", [1, 0, -1]),
      part("ballast", [0, 3, 0]),
      part("ballast", [0, 4, 0]),
      part("thruster", [3, 0, 0]),
    ]);
    expect(balanceAdvice(blueprint).height).toBe("high");
    expect(guideHint(balanceAdvice(blueprint), thrustGuides(blueprint))).toContain("아래");
  });
});
