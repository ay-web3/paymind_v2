import { CircleDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { v4 as uuidv4 } from 'uuid';

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
export class SwarmOrchestrator {
    private client: CircleDeveloperControlledWalletsClient;
    private registryAddress: string;
    private escrowAddress: string;

    constructor(config: SwarmMasterConfig) {
        this.client = new CircleDeveloperControlledWalletsClient(config.apiKey, config.entitySecret);
        this.registryAddress = config.registryAddress;
        this.escrowAddress = config.escrowAddress;
    }

    async executeForAgent(agentWalletId: string, action: string, params: any) {
        let signature = "";
        let contract = "";
        let abiParams = [];
        let amount = "0";

        switch(action) {
            case "register":
                contract = this.registryAddress;
                signature = "register(bool,bool,bytes32,bytes32)";
                abiParams = [params.asSeller, params.asVerifier, params.capHash, params.pubKey];
                amount = params.stake;
                break;
            case "updateProfile":
                contract = this.registryAddress;
                signature = "updateProfile(bytes32,bytes32,bool)";
                abiParams = [params.capHash, params.pubKey, true];
                break;
            case "createOpenTask":
                contract = this.escrowAddress;
                signature = "createOpenTask(uint64,uint64,uint64,bytes32,address[],uint8)";
                abiParams = [params.jobDeadline, params.bidDeadline, params.verifierDeadline, params.taskHash, params.verifiers, params.quorumM];
                amount = params.value || params.amount || "0";
                break;
            case "placeBid":
                contract = this.escrowAddress;
                signature = "placeBid(uint256,uint256,uint64,bytes32)";
                abiParams = [params.taskId, (parseFloat(params.price) * 10**18).toString(), params.eta.toString(), params.meta];
                break;
            case "selectBid":
                contract = this.escrowAddress;
                signature = "selectBid(uint256,uint256)";
                abiParams = [params.taskId, params.bidIndex];
                break;
            case "submitResult":
                contract = this.escrowAddress;
                signature = "submitResult(uint256,bytes32,string)";
                abiParams = [params.taskId, params.hash, params.uri];
                break;
            case "approveTask":
                contract = this.escrowAddress;
                signature = "approve(uint256)";
                abiParams = [params.taskId];
                break;
            case "finalizeTask":
                contract = this.escrowAddress;
                signature = "finalize(uint256)";
                abiParams = [params.taskId];
                break;
            case "timeoutRefund":
                contract = this.escrowAddress;
                signature = "timeoutRefund(uint256)";
                abiParams = [params.taskId];
                break;
            case "requestWithdraw":
                contract = this.registryAddress;
                signature = "requestWithdraw(uint256)";
                abiParams = [(parseFloat(params.amount) * 10**18).toString()];
                break;
            case "topUpStake":
                contract = this.registryAddress;
                signature = "topUpStake()";
                abiParams = [];
                amount = params.amount;
                break;
            case "completeWithdraw":
                contract = this.registryAddress;
                signature = "completeWithdraw()";
                abiParams = [];
                break;
            default:
                throw new Error("Unknown action");
        }

        return this.client.createContractExecutionTransaction({
            idempotencyKey: uuidv4(),
            walletId: agentWalletId,
            blockchain: "ARC-TESTNET",
            contractAddress: contract,
            abiFunctionSignature: signature,
            abiParameters: abiParams,
            amount: amount,
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });
    }
}
