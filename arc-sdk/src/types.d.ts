import { ethers } from "ethers";
export interface ArcSDKConfig {
    provider: ethers.Provider;
    signer?: ethers.Signer;
    registryAddress: string;
    escrowAddress: string;
}
export declare enum TaskState {
    NONE = 0,
    CREATED = 1,
    ACCEPTED = 2,
    SUBMITTED = 3,
    QUORUM_APPROVED = 4,
    REJECTED = 5,
    FINALIZED = 6,
    TIMEOUT_REFUNDED = 7,
    DISPUTED = 8,
    RESOLVED = 9
}
export interface AgentProfile {
    active: boolean;
    capabilitiesHash: string;
    pubKey: string;
}
export interface Task {
    buyer: string;
    seller: string;
    price: bigint;
    verifierPool: bigint;
    sellerBudget: bigint;
    deadline: bigint;
    bidDeadline: bigint;
    verifierDeadline: bigint;
    taskHash: string;
    resultHash: string;
    resultURI: string;
    state: TaskState;
    quorumM: number;
    quorumN: number;
}
//# sourceMappingURL=types.d.ts.map