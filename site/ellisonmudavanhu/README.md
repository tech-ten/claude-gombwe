# ellisonmudavanhu.com — personal page

Karpathy-style single-page personal site for **Tendai Ellison Mudavanhu**, mirrored at:

- **ellisonmudavanhu.com** (this folder's `index.html` is the canonical copy)
- **agentsform.ai/ellison.html** (a byte-identical copy lives at `../agentsformation/ellison.html`; keep the two in sync)

`index.html` is self-contained (inline CSS, no framework) so the same file works on both domains. The only asset is `images/headshot.png`.

Content follows the personal-focused CV
(`Tendai_Mudavanhu_AI_Applications_Infrastructure_Product_CV_Final.pdf`, 2026-07):
reverse-chronological career timeline, bio, current AI builds (Gombwe, AgentsForm,
AI Receptionist, TradeProcurement), capability, certs and education.

## What was preserved

`archive-2025-site/` holds the **complete previous ellisonmudavanhu.com** (the
"Cloud & Systems Expert" multi-page site: index/about/expertise/projects/contact
+ `styles/main.css` + `images/headshot.png`), downloaded verbatim from the live
bucket before the rewrite. Nothing was lost — the old cloud/network/5G framing and
project write-ups are all here if we want to pull anything back.

## Deploy

Both sites are S3 + CloudFront.

| Site | Bucket | CloudFront |
|---|---|---|
| ellisonmudavanhu.com | `ellisonmudavanhu-ellisonmudavanhucc45221c-bgh8jcqevxyj` (single-purpose — safe) | `EDY4XVA7LLSH4` |
| agentsform.ai | `www.agentsform.ai` (**hybrid — never `--delete`**, see `../agentsformation/README.md`) | `E1QP7Q4V8GZBLK` |

```bash
# --- ellisonmudavanhu.com ---
EMU=s3://ellisonmudavanhu-ellisonmudavanhucc45221c-bgh8jcqevxyj
aws s3 cp site/ellisonmudavanhu/index.html            $EMU/index.html --content-type text/html
aws s3 cp site/ellisonmudavanhu/images/headshot.png   $EMU/images/headshot.png --content-type image/png
# retire the old multi-page site (archived in archive-2025-site/):
for p in about expertise projects contact error; do aws s3 rm "$EMU/$p.html"; done
aws s3 rm "$EMU/styles/main.css"
aws cloudfront create-invalidation --distribution-id EDY4XVA7LLSH4 --paths "/*"

# --- agentsform.ai mirror (surgical cp only, never --delete) ---
AF=s3://www.agentsform.ai
aws s3 cp site/agentsformation/ellison.html           $AF/ellison.html --content-type text/html
aws s3 cp site/agentsformation/images/headshot.png    $AF/images/headshot.png --content-type image/png
aws s3 cp site/agentsformation/index.html             $AF/index.html --content-type text/html   # footer link
aws cloudfront create-invalidation --distribution-id E1QP7Q4V8GZBLK \
  --paths "/ellison.html" "/images/headshot.png" "/index.html"
```
