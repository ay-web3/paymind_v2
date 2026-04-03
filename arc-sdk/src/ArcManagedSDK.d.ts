export interface ArcManagedConfig {
    orchestratorUrl?: string;
    agentId?: string;
}
/**
 * @title ArcManagedSDK
 * @dev Secure SDK with ERC-8004 Identity & Reputation integration.
 */
export declare class ArcManagedSDK {
    private orchestratorUrl;
    private agentId;
    private agentSecret;
    private secretPath;
    private publicClient;
    constructor(config?: ArcManagedConfig);
    private loadSecret;
    private saveSecret;
    private requestAction;
    /**
     * @dev Onboards the agent, mints an ARC Identity NFT, and secures the wallet.
     */
    selfOnboard(agentName: string, metadataURI?: string): Promise<any>;
    private syncArcIdentity;
    getTask(id: string | number): Promise<any>;
    getTaskCounter(): Promise<any>;
    getAgentProfile(address: string): Promise<any>;
    getAgents(): Promise<any>;
    registerAgent(params: {
        asSeller: boolean;
        asVerifier: boolean;
        capHash: string;
        pubKey: string;
        stake: string;
    }): Promise<any>;
    updateProfile(params: {
        capHash: string;
        pubKey: string;
        active: boolean;
    }): Promise<any>;
    setRoles(params: {
        wantSeller: boolean;
        wantVerifier: boolean;
    }): Promise<any>;
    topUpStake(amount: string): Promise<any>;
    requestWithdraw(amount: string): Promise<any>;
    cancelWithdraw(): Promise<any>;
    completeWithdraw(): Promise<any>;
    createOpenTask(params: {
        jobDeadline: number;
        bidDeadline: number;
        verifierDeadline: number;
        taskHash: string;
        verifiers: string[];
        quorumM: number;
        amount: string;
    }): Promise<any>;
    selectBid(taskId: string, bidIndex: number): Promise<any>;
    finalizeAuction(taskId: string): Promise<any>;
    cancelIfNoBids(taskId: string): Promise<any>;
    timeoutRefund(taskId: string): Promise<any>;
    verifierTimeoutRefund(taskId: string): Promise<any>;
    openDispute(taskId: string): Promise<any>;
    placeBid(params: {
        taskId: string;
        price: string;
        eta?: number;
        meta?: string;
    }): Promise<any>;
    submitResult(params: {
        taskId: string;
        resultHash: string;
        resultURI: string;
    }): Promise<any>;
    approveTask(taskId: string): Promise<any>;
    rejectTask(taskId: string): Promise<any>;
    finalizeTask(taskId: string): Promise<any>;
    setSellerSlashBps(bps: number): Promise<any>;
    resolveDispute(params: {
        taskId: string;
        ruling: number;
        buyerBps: number;
    }): Promise<any>;
}
//# sourceMappingURL=ArcManagedSDK.d.ts.map