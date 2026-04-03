import { ethers } from "ethers";
import { ArcEconomySDK } from "./ArcEconomySDK";

async function main() {
    // ARC Testnet RPC
    const RPC_URL = "https://rpc.testnet.arc.network";
    const REGISTRY_ADDR = "0x700016cB8a2F8Ec7B41c583Cc42589Fd230752f9";
    const ESCROW_ADDR = "0x57082a289C34318ab216920947efd2FFB0b9981b";

    // IMPORTANT: To run this, you need a private key with USDC (ARC Native).
    const PRIVATE_KEY = process.env.ARC_PRIVATE_KEY;

    if (!PRIVATE_KEY) {
        console.error("ERROR: ARC_PRIVATE_KEY environment variable not set.");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    const sdk = new ArcEconomySDK({
        provider,
        signer: wallet,
        registryAddress: REGISTRY_ADDR,
        escrowAddress: ESCROW_ADDR
    });

    console.log(`Agent Address: ${wallet.address}`);
    
    // Check current registration status
    try {
        const profile = await sdk.getAgentProfile(wallet.address);
        if (profile.active) {
            console.log("Agent is already registered and active.");
            return;
        }
    } catch (e) {
        // Not registered yet
    }

    console.log("Registering agent on Arc Registry (ARC Testnet)...");
    
    // Register as a Seller with minimum required stake (50.0 USDC based on deployment logs)
    const tx = await sdk.registerAgent({
        asSeller: true,
        asVerifier: false,
        capabilitiesHash: ethers.id("openclaw-general-purpose-agent-v1"),
        pubKey: ethers.id(wallet.address), // Using hashed address as a placeholder pubKey for now
        stakeAmount: "50.0"
    });

    console.log(`Transaction Sent: ${tx.hash}`);
    console.log("Waiting for confirmation...");
    
    const receipt = await tx.wait();
    console.log("Registration Successful!");
    console.log(`Block: ${receipt.blockNumber}`);
}

main().catch(console.error);
