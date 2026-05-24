# Blog Ideas Registry

Ideas surfaced while writing "Who Owns AI-Commerce?" — topics that were conflated in the first post and deserve their own treatment.

## Queued posts

### 1. Model Lock-In and Portability
**Status:** Idea
**Trigger:** Managed agents bundles Claude with the orchestrator. What happens when OpenAI has a better model next quarter and entire businesses need to migrate?
**Key questions:**
- Is migration a config change or a rebuild?
- How should architectures treat models as interchangeable utilities?
- What does model-agnostic tooling actually look like in practice?
- MCP helps tools be portable — but what about prompts, context engineering, and model-specific optimisations?

### 2. Digital Sovereignty and AI-Commerce
**Status:** Idea
**Trigger:** Europe moving away from US platforms (Microsoft Teams). AI companies are defence contractors with national security obligations to home governments.
**Key questions:**
- When AI mediates all commerce in a country, where infrastructure lives is a sovereignty question
- What does "local AI infrastructure" actually mean when you're still on AWS?
- Is the concern the model inference location, the data location, or the governance?
- What are the policy frameworks that would protect local markets without blocking innovation?
- Australian data sovereignty requirements vs US CLOUD Act

### 3. The Economics of AI-Commerce
**Status:** Idea
**Trigger:** Who captures the margin when an AI agent mediates a purchase?
**Key questions:**
- In traditional e-commerce: retailer pays Amazon 15-30% referral fees. What's the equivalent in AI-commerce?
- Model provider captures token costs. Tool provider captures... nothing (currently). Retailer captures the sale. Who captures the customer relationship?
- Anthropic's marketplace takes 0% commission but monetises through token consumption. How does this compare to App Store (30%), Google Play (15-30%), Amazon (15%)?
- The "free tools feed paid platform" dynamic — is this sustainable? How did Android app developers respond to the same dynamic?

### 4. The End of Websites
**Status:** Idea
**Trigger:** MBS Microsoft AI Challenge vision (July 2024) — every device reduced to a prompt window
**Key questions:**
- What happens to businesses that are not agent-accessible?
- "Publishing an MCP endpoint is the equivalent of building a website in 1999" — unpack this
- How do small businesses become discoverable by AI agents?
- What's the transition path from website → API → MCP endpoint → agent-discoverable?
- SEO was the gatekeeping mechanism for websites. What's the equivalent for agent discovery?

### 5. Personal Agents vs Enterprise Agents
**Status:** Idea
**Trigger:** Gombwe is fundamentally different from Rakuten's managed agent deployment. Are these the same category?
**Key questions:**
- Enterprise agents: reliability, compliance, multi-tenant, SOC 2. Personal agents: zero cost, local data, scheduling, family context
- Is "personal agent" even the right term? Or is it just "automation that uses AI when needed"?
- The deterministic vs intelligent work split — when should a model be called vs a script?
- Can managed agents serve personal use cases, or is the architecture fundamentally enterprise-shaped?
- What does Gombwe's architecture look like if it served 10,000 households instead of 1?

### 6. The Proprietary Functions Layer
**Status:** Idea
**Trigger:** No retailer will build cross-competitor comparison tools. No model provider will build Australian grocery tools.
**Key questions:**
- Deep dive into what the proprietary functions layer actually contains
- Cross-retailer price comparison, independent recommendations, budget optimisation
- Who funds the development of public-interest tools in AI-commerce?
- Business models: open-source tools vs hosted services vs data aggregation
- The incentive structure: retailers want to showcase their own products, not enable comparison

### 7. AI-Commerce in Emerging Markets
**Status:** Idea
**Trigger:** $20/month Claude subscription is a barrier in Africa. WhatsApp is the dominant channel, not web apps.
**Key questions:**
- Channel economics: WhatsApp Business API costs vs model inference costs vs user willingness to pay
- Can AI-commerce leapfrog traditional e-commerce in Africa the way mobile payments leapfrogged banking?
- Data sovereignty in African markets — where should tools and data live?
- The zero-cost path: local models + deterministic scripts for price-sensitive markets
- Zimbabwe, Nigeria, Kenya — different markets, different channels, different constraints

## Published

### Who Owns AI-Commerce?
**Published:** 10 April 2026
**URL:** https://agentsform.ai/blog-managed-agents
**Summary:** Opening post. MBS vision, five layers of AI-commerce, managed agents as enterprise orchestrator, the layers nobody is building, call to action for developers/businesses/policymakers.
