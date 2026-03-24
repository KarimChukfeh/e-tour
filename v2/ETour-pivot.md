Sorry about the accidental tool calls there. Here’s the doc:

ETour Architecture Pivot
Date: March 2026
What We’re Changing and Why
ETour currently has hardcoded tiers and a fixed number of instances per game baked into the contracts. This made sense early on as a way to control storage costs, but it creates unnecessary bloat (100 pre-initialized instances sitting empty), pushes contracts close to the 24KB limit, and locks users into whatever configurations we decided upfront.
The pivot removes all of that.
New Contract Architecture
Instead of one contract holding all instance data, we move to a factory pattern. The game contract (or a factory contract) deploys a new lightweight child contract for each instance. The parent just stores an array of addresses pointing to those child contracts. Each child holds only its own state.
This means:
	∙	Storage scales with actual usage, not hypothetical usage
	∙	Each instance is isolated and self-contained
	∙	Contracts get smaller and faster, not larger over time
	∙	No more bytecode limit pressure from pre-initialized state
When an instance concludes (win, cancel, EL1, EL2) it closes permanently. The address stays on-chain as history. New instances can be created anytime by anyone for any configuration.
How Tiers Still Work
The tier logic (entry fee + player count = tier config) stays exactly as-is — it’s proven and battle-tested. The only change is how tiers get created. Instead of being hardcoded at deploy time, the UI lets users pick their parameters freely (e.g. 8 players, $5 entry). The contract checks if that tier config already exists. If yes, reuse it. If no, create it on the fly. Same underlying logic, just demand-driven instead of pre-provisioned.
Product Positioning Pivot
ETour stops trying to be a discovery platform and leans fully into what it actually is: the best place to settle scores with people you already know.
No bot detection, no skill-based matchmaking — and that’s fine, because that’s not the use case. The use case is: you challenged someone on Discord, now you want to make it real and permanent. You create an instance, set your parameters, share a link, they join.
Public instances (open lobbies) can still exist for people who want to browse, but they’re not the primary story anymore. The primary story is create → invite → play → permanent record.
This changes the UI framing from “find a tournament” to “create and invite.” It changes the whitepaper framing too. It changes the marketing from “jump in” to “prove it.”

Summary of Changes Needed
	∙	Remove all hardcoded instance initialization from contracts
	∙	Implement factory pattern: parent stores child addresses, children hold instance state
	∙	Add on-demand tier creation logic
	∙	Update UI primary flow to create → invite
	∙	Update whitepaper and landing page positioning accordingly
