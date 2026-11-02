import { MockVM, StringBytes } from "@koinos/sdk-as";
import { Counter } from "../Counter";
import { counter } from "../proto/counter";

describe("Public counter", () => {
  beforeEach(() => {
    MockVM.reset();
    MockVM.setContractId(new Uint8Array(25));
  });
  it("starts at zero", () => {
    expect(new Counter().get_count().count).toBe(0);
  });
  it("persists increments between instances", () => {
    new Counter().increment();
    expect(new Counter().increment().count).toBe(2);
    expect(new Counter().get_count().count).toBe(2);
  });
  it("refuses overflow", () => {
    const c = new Counter();
    const state = new counter.State();
    state.count = u32.MAX_VALUE;
    c.states.put(StringBytes.stringToBytes("count"), state);
    MockVM.commitTransaction();
    expect(() => { new Counter().increment(); }).toThrow();
    expect(c.get_count().count).toBe(u32.MAX_VALUE);
  });
});
