import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { arcTestnet } from 'viem/chains';

export interface ArcManagedConfig {
    orchestratorUrl?: string; 
    agentId?: string;         
}

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

/**
 * @title ArcManagedSDK
 * @dev Secure SDK with ERC-8004 Identity & Reputation integration.
 */
export class ArcManagedSDK {
    private orchestratorUrl: string = "https://arc-agent-economy-156980607075.europe-west1.run.app";
    private agentId: string | null = null;
    private agentSecret: string | null = null;
    private secretPath: string = path.join(process.cwd(), '.agent_secret');
    private publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

    constructor(config?: ArcManagedConfig) {
        if (config) {
            if (config.orchestratorUrl) this.orchestratorUrl = config.orchestratorUrl;
            if (config.agentId) this.agentId = config.agentId;
        }
        this.loadSecret();
    }

    private loadSecret() {
        if (fs.existsSync(this.secretPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.secretPath, 'utf8'));
                this.agentId = data.agentId;
                this.agentSecret = data.agentSecret;
            } catch (e) {
                console.error("[SDK] Failed to load .agent_secret:", e);
            }
        }
    }

    private saveSecret(agentId: string, agentSecret: string) {
        fs.writeFileSync(this.secretPath, JSON.stringify({ agentId, agentSecret }, null, 2));
    }

    private async requestAction(endpoint: string, params: any) {
        if (!this.agentId && endpoint !== 'onboard') {
            throw new Error("Agent not onboarded.");
        }

        const response = await axios.post(`${this.orchestratorUrl}/${endpoint}`, {
            agentId: this.agentId,
            agentSecret: this.agentSecret,
            ...params
        });

        return response.data;
    }

    /**
     * @dev Onboards the agent, mints an ARC Identity NFT, and secures the wallet.
     */
    async selfOnboard(agentName: string, metadataURI?: string) {
        console.log(`[SDK] Secure Onboarding & Identity Minting for: ${agentName}`);
        const data = await this.requestAction("onboard", { agentName, metadataURI });
        
        if (data.agentSecret && data.agentId) {
            this.agentId = data.agentId;
            this.agentSecret = data.agentSecret;
            this.saveSecret(this.agentId, this.agentSecret);
            
            console.log(`[SDK] identity secured. Waiting for ARC Identity NFT mint...`);
            // Attempt to find the minted Token ID
            setTimeout(() => this.syncArcIdentity(data.address), 10000);
        }
        return data;
    }

    private async syncArcIdentity(address: string) {
        try {
            const logs = await this.publicClient.getLogs({
                address: IDENTITY_REGISTRY,
                event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
                args: { to: address as `0x${string}` },
                fromBlock: 'latest'
            });
            if (logs && logs.length > 0) {
                const lastLog = logs[logs.length - 1];
                if (lastLog && lastLog.args && lastLog.args.tokenId) {
                    const tokenId = lastLog.args.tokenId.toString();
                    await this.requestAction("updateArcIdentity", { tokenId });
                    console.log(`[SDK] ERC-8004 Identity Linked: Token #${tokenId}`);
                }
            }
        } catch (e) { console.error("Identity sync failed:", e); }
    }

    // --- READ ACTIONS ---

    async getTask(id: string | number) {
        const response = await axios.get(`${this.orchestratorUrl}/escrow/task/${id}`);
        return response.data;
    }

    async getTaskCounter() {
        const response = await axios.get(`${this.orchestratorUrl}/escrow/counter`);
        return response.data.count;
    }

    async getAgentProfile(address: string) {
        const response = await axios.get(`${this.orchestratorUrl}/registry/profile/${address}`);
        return response.data;
    }

    async getAgents() {
        return this.requestAction("agents", {});
    }

    // --- AGENT REGISTRY ACTIONS ---

    async registerAgent(params: { asSeller: boolean, asVerifier: boolean, capHash: string, pubKey: string, stake: string }) {
        return this.requestAction("execute/register", params);
    }

    async updateProfile(params: { capHash: string, pubKey: string, active: boolean }) {
        return this.requestAction("execute/updateProfile", params);
    }

    async setRoles(params: { wantSeller: boolean, wantVerifier: boolean }) {
        return this.requestAction("execute/setRoles", params);
    }

    async topUpStake(amount: string) {
        return this.requestAction("execute/topUpStake", { amount });
    }

    async requestWithdraw(amount: string) {
        return this.requestAction("execute/withdraw/request", { amount });
    }

    async cancelWithdraw() {
        return this.requestAction("execute/withdraw/cancel", {});
    }

    async completeWithdraw() {
        return this.requestAction("execute/withdraw/complete", {});
    }

    // --- BUYER ACTIONS ---

    async createOpenTask(params: { 
        jobDeadline: number, 
        bidDeadline: number, 
        verifierDeadline: number,
        taskHash: string, 
        verifiers: string[], 
        quorumM: number, 
        amount?: string,
        value?: string
    }) {
        const amount = params.amount || params.value;
        const payload = {
            ...params,
            amount: amount,
            value: amount
        };
        return this.requestAction("execute/createOpenTask", payload);
    }

    async selectBid(taskId: string, bidIndex: number) {
        return this.requestAction("execute/selectBid", { taskId, bidIndex });
    }

    async finalizeAuction(taskId: string) {
        return this.requestAction("execute/finalizeAuction", { taskId });
    }

    async cancelIfNoBids(taskId: string) {
        return this.requestAction("execute/cancelIfNoBids", { taskId });
    }

    async timeoutRefund(taskId: string) {
        return this.requestAction("execute/timeoutRefund", { taskId });
    }

    async verifierTimeoutRefund(taskId: string) {
        return this.requestAction("execute/verifierTimeoutRefund", { taskId });
    }

    async openDispute(taskId: string) {
        return this.requestAction("execute/openDispute", { taskId });
    }

    // --- SELLER ACTIONS ---

    async placeBid(params: { taskId: string, price: string, eta?: number, meta?: string }) {
        return this.requestAction("execute/placeBid", params);
    }

    async submitResult(params: { taskId: string, hash?: string, resultHash?: string, uri?: string, resultURI?: string }) {
        const hash = params.hash || params.resultHash;
        const uri = params.uri || params.resultURI;
        const payload = {
            taskId: params.taskId,
            hash: hash,
            resultHash: hash,
            uri: uri,
            resultURI: uri
        };
        return this.requestAction("execute/submitResult", payload);
    }

    // --- VERIFIER ACTIONS ---

    async approveTask(taskId: string) {
        return this.requestAction("execute/approve", { taskId });
    }

    async rejectTask(taskId: string) {
        return this.requestAction("execute/reject", { taskId });
    }

    // --- KEEPER / SYSTEM ACTIONS ---

    async finalizeTask(taskId: string) {
        return this.requestAction("execute/finalize", { taskId });
    }

    // --- GOVERNANCE ACTIONS ---

    async setSellerSlashBps(bps: number) {
        return this.requestAction("execute/setSellerSlashBps", { bps });
    }

    async resolveDispute(params: { taskId: string, ruling: number, buyerBps: number }) {
        return this.requestAction("execute/resolveDispute", params);
    }
}
