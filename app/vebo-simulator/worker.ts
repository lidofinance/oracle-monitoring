import { simulateExits, validateScenario } from "../vebo-simulation";
self.onmessage=(event:MessageEvent)=>{try{self.postMessage({reports:simulateExits(validateScenario(event.data))});}catch(error){self.postMessage({error:error instanceof Error ? error.message : "Simulation failed"});}};
