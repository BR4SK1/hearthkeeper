import { describe, expect, it } from "vitest";
import {
  identityKey,
  nextRevision,
  transitionStatus,
  ObservationLifecycleError,
} from "./observations.js";

describe("identityKey", () => {
  it("formats as campaignId:subjectKey:kind", () => {
    expect(
      identityKey({ campaignId: "camp", subjectKey: "subject", kind: "kind" }),
    ).toBe("camp:subject:kind");
  });
});

describe("transitionStatus", () => {
  it("allows the legal transitions", () => {
    expect(transitionStatus("active", "superseded")).toBe("superseded");
    expect(transitionStatus("active", "retracted")).toBe("retracted");
    expect(transitionStatus("superseded", "retracted")).toBe("retracted");
  });

  it("rejects any resurrection to active", () => {
    expect(() => transitionStatus("active", "active")).toThrowError(
      ObservationLifecycleError,
    );
    expect(() => transitionStatus("superseded", "active")).toThrowError(
      ObservationLifecycleError,
    );
  });

  it("retracted is terminal", () => {
    expect(() => transitionStatus("retracted", "active")).toThrowError(
      ObservationLifecycleError,
    );
    expect(() => transitionStatus("retracted", "superseded")).toThrowError(
      ObservationLifecycleError,
    );
    expect(() => transitionStatus("retracted", "retracted")).toThrowError(
      ObservationLifecycleError,
    );
  });
});

describe("nextRevision", () => {
  it("increments", () => {
    expect(nextRevision(0)).toBe(1);
    expect(nextRevision(7)).toBe(8);
  });
});
