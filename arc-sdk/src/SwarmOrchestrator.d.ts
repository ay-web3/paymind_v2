export interface SwarmMasterConfig {
    apiKey: string;
    entitySecret: string;
    registryAddress: string;
    escrowAddress: string;
}
/**
 * @title SwarmOrchestrator
 * @dev The "Swarm Master" logic.
 * This is the ONLY component that holds the Circle API Key and Entity Secret.
 * It listens to requests from "Zero-Secret" agents and executes them on their behalf.
 */
export declare class SwarmOrchestrator {
    private client;
    private registryAddress;
    private escrowAddress;
    constructor(config: SwarmMasterConfig);
    executeForAgent(agentWalletId: string, action: string, params: any): Promise<import("@circle-fin/developer-controlled-wallets").TrimDataResponse<import("@circle-fin/developer-controlled-wallets").CreateContractExecutionTransactionForDeveloper>>;
}
//# sourceMappingURL=SwarmOrchestrator.d.ts.map