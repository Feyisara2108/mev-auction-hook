import { createConfig, http } from "wagmi";
import { anvil, unichainSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [unichainSepolia, anvil],
  connectors: [injected()],
  transports: {
    [anvil.id]: http(process.env.NEXT_PUBLIC_ANVIL_RPC ?? "http://127.0.0.1:8545"),
    [unichainSepolia.id]: http(
      process.env.NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC ??
        "https://sepolia.unichain.org"
    ),
  },
});
