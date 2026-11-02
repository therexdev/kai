import { System, Storage, StringBytes } from "@koinos/sdk-as";
import { counter } from "./proto/counter";

// A public counter: any caller may increment it. It holds no funds.
export class Counter {
  states: Storage.Map<Uint8Array, counter.State> = new Storage.Map(
    System.getContractId(), 0, counter.State.decode, counter.State.encode,
  );
  get_count(): counter.State {
    const state = this.states.get(StringBytes.stringToBytes("count"));
    return state === null ? new counter.State() : state;
  }
  increment(): counter.State {
    const state = this.get_count();
    System.require(state.count < u32.MAX_VALUE, "Counter is full");
    state.count += 1;
    this.states.put(StringBytes.stringToBytes("count"), state);
    return state;
  }
}
