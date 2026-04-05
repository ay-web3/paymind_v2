import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createPublicClient, http, parseAbiItem, keccak256, toBytes } from 'viem';
import { arcTestnet } from 'viem/chains';
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
/**
 * @title ArcManagedSDK
 * @dev Secure SDK with ERC-8004 Identity & Reputation integration.
 */
export class ArcManagedSDK {
    orchestratorUrl = "https://arc-agent-economy-156980607075.europe-west1.run.app";
    agentId = null;
    agentSecret = null;
    secretPath = path.join(process.cwd(), '.agent_secret');
    publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
    constructor(config) {
        if (config) {
            if (config.orchestratorUrl)
                this.orchestratorUrl = config.orchestratorUrl;
            if (config.agentId)
                this.agentId = config.agentId;
            if (config.secretPath)
                this.secretPath = config.secretPath;
        }
        this.loadSecret();
    }
    /**
     * @dev Generates a deterministic Keccak256 hash for task or result metadata.
     */
    generateMetadataHash(metadata) {
        const str = JSON.stringify(metadata, Object.keys(metadata).sort());
        return keccak256(toBytes(str));
    }
    /**
     * @dev Resolves a URI to a human-clickable link.
     */
    resolveEvidenceURI(uri, gateway = "https://ipfs.io/ipfs/") {
        if (uri.startsWith("ipfs://")) {
            return uri.replace("ipfs://", gateway);
        }
        return uri;
    }
    loadSecret() {
        if (fs.existsSync(this.secretPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.secretPath, 'utf8'));
                this.agentId = data.agentId;
                this.agentSecret = data.agentSecret;
            }
            catch (e) {
                console.error("[SDK] Failed to load .agent_secret:", e);
            }
        }
    }
    saveSecret(agentId, agentSecret) {
        fs.writeFileSync(this.secretPath, JSON.stringify({ agentId, agentSecret }, null, 2));
    }
    async requestAction(endpoint, params) {
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
    async selfOnboard(agentName, metadataURI) {
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
    async syncArcIdentity(address) {
        try {
            const logs = await this.publicClient.getLogs({
                address: IDENTITY_REGISTRY,
                event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
                args: { to: address },
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
        }
        catch (e) {
            console.error("Identity sync failed:", e);
        }
    }
    // --- READ ACTIONS ---
    async getTask(id) {
        const response = await axios.get(`${this.orchestratorUrl}/escrow/task/${id}`);
        return response.data;
    }
    async getTaskCounter() {
        const response = await axios.get(`${this.orchestratorUrl}/escrow/counter`);
        return response.data.count;
    }
    async getAgentProfile(address) {
        const response = await axios.get(`${this.orchestratorUrl}/registry/profile/${address}`);
        return response.data;
    }
    async getAgents() {
        return this.requestAction("agents", {});
    }
    // --- AGENT REGISTRY ACTIONS ---
    async registerAgent(params) {
        return this.requestAction("execute/register", params);
    }
    async updateProfile(params) {
        return this.requestAction("execute/updateProfile", params);
    }
    async setRoles(params) {
        return this.requestAction("execute/setRoles", params);
    }
    async topUpStake(amount) {
        return this.requestAction("execute/topUpStake", { amount });
    }
    async requestWithdraw(amount) {
        return this.requestAction("execute/withdraw/request", { amount });
    }
    async cancelWithdraw() {
        return this.requestAction("execute/withdraw/cancel", {});
    }
    async completeWithdraw() {
        return this.requestAction("execute/withdraw/complete", {});
    }
    // --- BUYER ACTIONS ---
    async createOpenTask(params) {
        const amount = params.amount || params.value;
        const payload = {
            ...params,
            amount: amount,
            value: amount
        };
        return this.requestAction("execute/createOpenTask", payload);
    }
    async selectBid(taskId, bidIndex) {
        return this.requestAction("execute/selectBid", { taskId, bidIndex });
    }
    async finalizeAuction(taskId) {
        return this.requestAction("execute/finalizeAuction", { taskId });
    }
    async cancelIfNoBids(taskId) {
        return this.requestAction("execute/cancelIfNoBids", { taskId });
    }
    async timeoutRefund(taskId) {
        return this.requestAction("execute/timeoutRefund", { taskId });
    }
    async verifierTimeoutRefund(taskId) {
        return this.requestAction("execute/verifierTimeoutRefund", { taskId });
    }
    async openDispute(taskId) {
        return this.requestAction("execute/openDispute", { taskId });
    }
    // --- SELLER ACTIONS ---
    async placeBid(params) {
        return this.requestAction("execute/placeBid", params);
    }
    async submitResult(params) {
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
    async approveTask(taskId) {
        return this.requestAction("execute/approve", { taskId });
    }
    async rejectTask(taskId) {
        return this.requestAction("execute/reject", { taskId });
    }
    // --- KEEPER / SYSTEM ACTIONS ---
    async finalizeTask(taskId) {
        return this.requestAction("execute/finalize", { taskId });
    }
    // --- GOVERNANCE ACTIONS ---
    async setSellerSlashBps(bps) {
        return this.requestAction("execute/setSellerSlashBps", { bps });
    }
    async resolveDispute(params) {
        return this.requestAction("execute/resolveDispute", params);
    }
}
//# sourceMappingURL=ArcManagedSDK.js.map