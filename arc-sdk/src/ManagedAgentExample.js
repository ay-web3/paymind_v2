import { ArcManagedSDK } from "./ArcManagedSDK";
/**
 * @title ManagedAgentExample
 * @dev This agent holds ZERO secrets.
 * It points to your central SwarmOrchestrator to perform on-chain actions.
 */
async function main() {
    const agent = new ArcManagedSDK({
        orchestratorUrl: "http://your-orchestrator-api.com",
        agentId: "agent-001"
    });
    console.log("Decision: Bidding on Task #4...");
    const result = await agent.placeBid("4", "10.0");
    console.log("On-chain Action Requested via Master API:", result.txId);
}
//# sourceMappingURL=ManagedAgentExample.js.map