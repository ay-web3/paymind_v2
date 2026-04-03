const express = require('express');
const { CircleDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');
const { v4: uuidv4 } = require('uuid');
const app = express();
app.use(express.json());

/**
 * @title SwarmOrchestratorAPI
 * @dev Reference implementation of the "Swarm Master" API.
 * This server holds the Circle API Key and Entity Secret.
 */

// Load these from your private .env file
const API_KEY = process.env.CIRCLE_API_KEY;
const ENTITY_SECRET = process.env.ENTITY_SECRET;
const WALLET_SET_ID = process.env.WALLET_SET_ID; // The ID of your Arc Argent Wallet Set

const REGISTRY_CA = "0x700016cB8a2F8Ec7B41c583Cc42589Fd230752f9";
const ESCROW_CA = "0x57082a289C34318ab216920947efd2FFB0b9981b";

const client = new CircleDeveloperControlledWalletsClient(API_KEY, ENTITY_SECRET);

// Store for mapping agentIds to their newly created walletIds
// In production, use a persistent database
const AGENT_DATABASE = {};

/**
 * @route POST /onboard
 * @dev Automatically provisions a new secure wallet for a brand new agent.
 */
app.post('/onboard', async (req, res) => {
    const { agentName } = req.body;
    const idempotencyKey = uuidv4();

    try {
        console.log(`[ORCHESTRATOR] Auto-provisioning wallet for: ${agentName}`);
        
        const response = await client.createWallets({
            idempotencyKey: idempotencyKey,
            accountType: "EOA",
            blockchains: ["ARC-TESTNET"],
            count: 1,
            walletSetId: WALLET_SET_ID
        });

        const newWallet = response.data.wallets[0];
        
        // Map the internal name to the Circle Wallet ID
        AGENT_DATABASE[agentName] = newWallet.id;

        res.json({ 
            success: true, 
            agentId: agentName,
            walletId: newWallet.id,
            address: newWallet.address 
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * @route POST /execute
 * @dev Executes on-chain actions for managed agents.
 */
app.post('/execute', async (req, res) => {
    const { agentId, action, params } = req.body;
    const walletId = AGENT_DATABASE[agentId];

    if (!walletId) return res.status(404).json({ error: "Agent ID not onboarded" });

    try {
        let payload = {
            idempotencyKey: uuidv4(),
            walletId: walletId,
            blockchain: "ARC-TESTNET",
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        };

        if (action === "placeBid") {
            payload = {
                ...payload,
                contractAddress: ESCROW_CA,
                abiFunctionSignature: "placeBid(uint256,uint256,uint64,bytes32)",
                abiParameters: [params.taskId, (parseFloat(params.price) * 10**6).toString(), "3600", "0x0"]
            };
        }
        // ... (Implement other cases)

        const response = await client.createContractExecutionTransaction(payload);
        res.json({ success: true, txId: response.data.transaction.id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(3001, () => console.log(`Orchestrator running on port 3001`));
