from __future__ import annotations

from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
FONT_DIR = DOCS / "assets" / "fonts"


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / name), size=size)


F = {
    "regular": lambda size: font("Poppins-Regular.ttf", size),
    "semibold": lambda size: font("Poppins-SemiBold.ttf", size),
    "bold": lambda size: font("Poppins-Bold.ttf", size),
    "xbold": lambda size: font("Poppins-ExtraBold.ttf", size),
}


INK = "#0f172a"
MUTED = "#475569"
GREEN = "#2f7d32"
ORANGE = "#ff3d1f"
BLUE = "#0ea5e9"
RZP = "#2563eb"


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, fill: str, fnt: ImageFont.FreeTypeFont, **kw) -> None:
    draw.text(xy, value, fill=fill, font=fnt, **kw)


def wrapped(
    draw: ImageDraw.ImageDraw,
    value: str,
    xy: tuple[int, int],
    width: int,
    fnt: ImageFont.FreeTypeFont,
    fill: str = INK,
    line_gap: int = 8,
) -> int:
    x, y = xy
    chars = max(10, int(width / max(9, fnt.size * 0.55)))
    for raw in value.split("\n"):
        for line in wrap(raw, chars) or [""]:
            draw.text((x, y), line, fill=fill, font=fnt)
            y += fnt.size + line_gap
    return y


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: str, outline: str | None = None, width: int = 2) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def arrow(draw: ImageDraw.ImageDraw, start: tuple[int, int], end: tuple[int, int], fill: str = "#1d4ed8", width: int = 5) -> None:
    draw.line((start, end), fill=fill, width=width)
    x1, y1 = start
    x2, y2 = end
    if abs(x2 - x1) >= abs(y2 - y1):
        direction = 1 if x2 >= x1 else -1
        pts = [(x2, y2), (x2 - 22 * direction, y2 - 12), (x2 - 22 * direction, y2 + 12)]
    else:
        direction = 1 if y2 >= y1 else -1
        pts = [(x2, y2), (x2 - 12, y2 - 22 * direction), (x2 + 12, y2 - 22 * direction)]
    draw.polygon(pts, fill=fill)


def icon_circle(draw: ImageDraw.ImageDraw, center: tuple[int, int], label: str, bg: str, fg: str = "#ffffff", size: int = 54) -> None:
    x, y = center
    draw.ellipse((x - size, y - size, x + size, y + size), fill=bg)
    fnt = F["xbold"](38 if len(label) <= 2 else 30)
    bbox = draw.textbbox((0, 0), label, font=fnt)
    draw.text((x - (bbox[2] - bbox[0]) / 2, y - (bbox[3] - bbox[1]) / 2 - 3), label, fill=fg, font=fnt)


def proposed_solution() -> None:
    w, h = 3840, 2160
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)

    # Header
    d.ellipse((48, 48, 420, 204), outline="#0a0a0a", width=8)
    text(d, (144, 126), "Nukkad", INK, F["bold"](34), anchor="lm")
    text(d, (w // 2, 72), "Proposed Solution", "#0a0a0a", F["bold"](58), anchor="ma")
    rounded(d, (3138, 56, 3256, 174), 28, RZP)
    d.polygon([(3180, 148), (3210, 88), (3250, 88), (3218, 126), (3256, 126), (3166, 214), (3196, 148)], fill="white")
    text(d, (3296, 78), "RAZORPAY AI", INK, F["xbold"](32))
    text(d, (3296, 116), "BUILDATHON", INK, F["xbold"](32))
    text(d, (3296, 154), "2026", INK, F["xbold"](32))

    # Left problem section
    text(d, (112, 260), "The Problem and Its Consequences", "#222222", F["bold"](42))
    problem = (
        "Local kirana stores are losing daily essentials demand to Blinkit, Zepto and quick-delivery apps. "
        "Customers now expect home delivery, zero effort ordering, digital bills and instant payment links, "
        "while most shops still depend on manual WhatsApp notes, phone calls, Paytm or PhonePe collection, and memory-based stock."
    )
    wrapped(d, problem, (112, 318), 940, F["regular"](24), "#1f2937", 8)

    problems = [
        ("01", "Customer Habit\nShifted Online", "Families choose quick apps because ordering takes no call, no typing and delivery comes straight home.", "APP"),
        ("02", "Manual Operations\nCannot Match Apps", "Stock, orders, customer reminders and supplier calls stay manual, so service feels slower and uncertain.", "OPS"),
        ("03", "Payments Stay\nOutside Razorpay", "Many kiranas collect through Paytm, PhonePe or cash, so Razorpay stays a side gateway on large platforms.", "UPI"),
        ("04", "No Proactive\nCustomer Intelligence", "The shop knows customers personally, but cannot calculate when atta, oil, salt or tea will run out.", "AI"),
    ]
    positions = [(112, 508), (900, 508), (112, 846), (900, 846)]
    for (num, title, body, ic), (x, y) in zip(problems, positions):
        d.line((x, y, x, y + 294), fill=ORANGE, width=5)
        text(d, (x + 40, y + 18), num, ORANGE, F["xbold"](54))
        text(d, (x + 138, y + 30), title, GREEN, F["bold"](24))
        d.line((x + 40, y + 102, x + 112, y + 102), fill=ORANGE, width=4)
        wrapped(d, body, (x + 40, y + 126), 390, F["regular"](17), "#1f2937", 5)
        icon_circle(d, (x + 616, y + 140), ic, "#fff4ee", ORANGE if ic in {"UPI", "OPS"} else "#16a34a", 68)

    # Right solution section
    text(d, (1930, 260), "What Nukkad Actually Builds", "#222222", F["bold"](42))
    highlights = [
        "Nukkad turns a kirana into an AI commerce desk:",
        "reads supplier bills, updates the catalogue, predicts household run-out,",
        "calls customers in Hinglish, builds an editable basket, sends a Razorpay payment link on WhatsApp,",
    ]
    y = 330
    for line in highlights:
        d.rectangle((1930, y, 3300 if len(line) < 70 else 3540, y + 32), fill="#fff42a")
        text(d, (1930, y - 2), line, INK, F["regular"](24))
        y += 40
    wrapped(
        d,
        "and settles stock only after verified payment. Razorpay moves from a passive checkout button into the operating layer for local retail.",
        (1930, y),
        1260,
        F["regular"](24),
        "#1f2937",
        8,
    )

    # Illustration
    base_y = 1120
    d.polygon([(1920, base_y), (2220, 850), (2520, 1120)], fill="#d9f99d")
    d.polygon([(2120, base_y), (2500, 790), (2920, 1120)], fill="#bef264")
    d.polygon([(2630, base_y), (3050, 910), (3580, 1120)], fill="#84cc16")
    d.rectangle((1920, base_y, 3580, base_y + 120), fill="#8cc63e")
    # shop
    rounded(d, (1920, 860, 2148, 1060), 16, "#fff7ed", "#111827", 6)
    d.polygon([(1904, 860), (2172, 860), (2140, 798), (1936, 798)], fill="#ef4444", outline="#111827")
    text(d, (2026, 848), "KIRANA", "#111827", F["xbold"](36), anchor="mm")
    d.rectangle((1950, 950, 2010, 1060), fill="#16a34a")
    d.rectangle((2050, 948, 2120, 1018), fill="#fef3c7", outline="#111827", width=4)
    # network lines
    for yy in [906, 1004, 1080]:
        d.arc((2180, yy - 110, 3090, yy + 110), 190, 350, fill=GREEN, width=4)
    d.line((2200, 965, 2910, 965), fill="#111827", width=5)
    arrow(d, (2910, 965), (3220, 910), GREEN, 6)
    arrow(d, (2920, 1040), (3230, 1028), GREEN, 6)
    icon_circle(d, (2610, 800), "RZP", "#dbeafe", RZP, 76)
    d.ellipse((2538, 728, 2682, 872), outline=RZP, width=6)
    rounded(d, (2720, 920, 2948, 1018), 12, "#ecfdf5", "#166534", 4)
    text(d, (2834, 962), "SUPPLIER", "#166534", F["xbold"](22), anchor="mm")
    text(d, (2834, 996), "night order", "#166534", F["semibold"](17), anchor="mm")
    rounded(d, (3168, 724, 3270, 906), 18, "#111827")
    rounded(d, (3195, 748, 3243, 852), 8, "#ecfdf5")
    d.ellipse((3212, 872, 3226, 886), fill="white")
    d.arc((3000, 728, 3120, 910), 115, 245, fill=ORANGE, width=7)
    d.arc((3060, 704, 3190, 930), 115, 245, fill=ORANGE, width=7)

    # Features
    text(d, (198, 1300), "Unique Key Features", "#222222", F["bold"](42))
    features = [
        ("01", "WhatsApp-First\nShopfront", "Customers order from the same chat they already use: text, photo, voice-note and payment replies."),
        ("02", "Bill OCR to\nLive Catalogue", "Supplier bills are read by vision, repaired, priced and merged into SKUs with a critic before persistence."),
        ("03", "Grounded Product\nResolution", "Hinglish requests map to real catalogue rows using aliases, fuzzy match, stock and household purchase prior."),
        ("04", "Realtime Care\nCalling Agent", "Twilio streams call audio, Sarvam listens and speaks, and barge-in keeps the call feeling natural."),
        ("05", "Desk-Based\nAgent Runtime", "Reception, Seller, Checkout and Enquiry share memory, pending actions, basket and typed outcomes."),
        ("06", "Razorpay-Led\nLocal Payments", "Payment links are generated after final basket approval; webhooks verify money before stock or fulfilment moves."),
        ("07", "Measured Agent\nReliability", "Dialogue, resolver, photo, bill OCR, payment safety, ASR/TTS and latency harnesses test production modules."),
    ]
    card_w, gap, x0 = 424, 42, 164
    for i, (num, title, body) in enumerate(features):
        x = x0 + i * (card_w + gap)
        y = 1418
        rounded(d, (x, y, x + card_w, y + 496), 12, "white", "#9fca95", 3)
        text(d, (x + 52, y + 42), num, GREEN, F["xbold"](48))
        d.line((x + 52, y + 112, x + 128, y + 112), fill=GREEN, width=4)
        wrapped(d, title, (x + 52, y + 164), card_w - 104, F["bold"](21), GREEN, 3)
        wrapped(d, body, (x + 52, y + 272), card_w - 104, F["regular"](19), "#111827", 7)
        d.pieslice((x + card_w // 2 - 42, y + 466, x + card_w // 2 + 42, y + 550), 180, 360, fill=GREEN)

    d.rectangle((0, 2058, w, h), fill=BLUE)
    text(d, (w // 2, 2118), "Razorpay AI Buildathon 2026 - Nukkad", "white", F["semibold"](23), anchor="mm")
    text(d, (3720, 2118), "2", "white", F["semibold"](30), anchor="mm")
    img.save(DOCS / "nukkad-proposed-solution-4k.png", quality=95)


def box(
    d: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    title: str,
    body: str,
    fill: str,
    outline: str,
    title_color: str = INK,
) -> None:
    rounded(d, xy, 16, fill, outline, 3)
    x1, y1, x2, _ = xy
    text(d, (x1 + 24, y1 + 18), title, title_color, F["bold"](22))
    wrapped(d, body, (x1 + 24, y1 + 58), x2 - x1 - 48, F["regular"](16), MUTED, 4)


def technical_architecture() -> None:
    w, h = 3840, 2160
    img = Image.new("RGB", (w, h), "#f8fafc")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, w, 190), fill="#0f172a")
    text(d, (80, 72), "Nukkad Technical Architecture", "white", F["xbold"](62))
    text(d, (80, 144), "Agentic kirana commerce: WhatsApp OCR, realtime voice calls, grounded baskets, Razorpay settlement and eval harnesses.", "#cbd5e1", F["regular"](22))
    rounded(d, (3120, 44, 3300, 150), 24, RZP)
    text(d, (3210, 98), "RZP", "white", F["xbold"](38), anchor="mm")
    text(d, (3340, 68), "Razorpay AI", "white", F["xbold"](30))
    text(d, (3340, 106), "Buildathon 2026", "#dbeafe", F["bold"](26))

    # Top stack badges
    stack = [
        ("Next.js", "#111827"), ("React", "#61dafb"), ("TS", "#3178c6"), ("Fastify", "#111827"),
        ("Prisma", "#0c344b"), ("PG", "#336791"), ("Groq", "#f97316"), ("Sarvam", "#14b8a6"),
        ("Twilio", "#f22f46"), ("Razorpay", RZP), ("Render", "#46e3b7"), ("Vercel", "#111827"),
    ]
    x = 88
    for label, color in stack:
        rounded(d, (x, 230, x + 236, 312), 18, color)
        text(d, (x + 118, 272), label, "white" if color != "#61dafb" else "#082f49", F["bold"](26), anchor="mm")
        x += 260

    # Architecture lanes
    lanes = [
        ("1. Shop Brain", 80, 380, 1120, 880, "#ecfdf5", "#10b981", [
            ("Landing + OTP", "owner session, cookie, kirana profile"),
            ("Dashboard", "catalogue, inventory, orders, customers"),
            ("Shop Graph", "store, households, suppliers, offers"),
        ]),
        ("2. WhatsApp Commerce", 80, 960, 1120, 1600, "#eff6ff", "#2563eb", [
            ("Inbound Webhook", "Evolution/Twilio normalises text, image, audio"),
            ("Bill OCR", "vision extracts rows, repairs units and prices"),
            ("Catalogue Match", "aliases, fuzzy match, stock and priors"),
            ("Basket + Payment", "order edits, Razorpay link, WhatsApp receipt"),
        ]),
        ("3. Realtime Voice Agent", 1280, 380, 2500, 1600, "#fff7ed", "#f97316", [
            ("Twilio Call", "Media Stream opens WebSocket"),
            ("PCM Bridge", "8k mu-law frames to 16k PCM"),
            ("Sarvam Ear", "streaming STT, partials, VAD, barge-in"),
            ("Agent Desks", "Reception, Seller, Checkout, Enquiry"),
            ("Sarvam Mouth", "low-latency Hinglish TTS reply"),
            ("Call Journal", "heard text, decision, tool, verified result"),
        ]),
        ("4. Shared Agent Runtime", 2660, 380, 3760, 1060, "#f5f3ff", "#7c3aed", [
            ("Turn Door", "one final utterance becomes one outcome"),
            ("Memory Stack", "desk, pending action, referents, TTL"),
            ("Policy Table", "state decides what yes/no/bhej do means"),
            ("Grounded Tools", "catalogue, basket, payment, stock"),
        ]),
        ("5. Measurement + Safety", 2660, 1160, 3760, 1600, "#fff1f2", "#e11d48", [
            ("Payment Safety", "webhook and API verification, never inferred"),
            ("Eval Harnesses", "dialogue, OCR, resolver, payment, latency"),
            ("Owner Visibility", "timeline shows heard, desk, tool, result"),
        ]),
    ]
    for title, x1, y1, x2, y2, fill, border, items in lanes:
        rounded(d, (x1, y1, x2, y2), 28, fill, border, 3)
        text(d, (x1 + 36, y1 + 34), title, INK, F["xbold"](30))
        cols = 2 if x2 - x1 > 900 else 1
        item_w = (x2 - x1 - 100 - (cols - 1) * 30) // cols
        item_h = 136
        for idx, (it, body) in enumerate(items):
            col = idx % cols
            row = idx // cols
            bx = x1 + 36 + col * (item_w + 30)
            by = y1 + 100 + row * (item_h + 28)
            box(d, (bx, by, bx + item_w, by + item_h), it, body, "white", border)
            if idx < len(items) - 1 and col == 0:
                arrow(d, (bx + item_w, by + item_h // 2), (min(bx + item_w + 30, x2 - 50), by + item_h // 2), border, 4)

    # Data flow spine
    d.line((1180, 700, 1260, 700), fill="#0f766e", width=7)
    arrow(d, (1120, 700), (1280, 700), "#0f766e", 7)
    arrow(d, (2500, 700), (2660, 700), "#7c3aed", 7)
    arrow(d, (3200, 1060), (3200, 1160), "#e11d48", 7)
    arrow(d, (640, 1600), (640, 1770), "#2563eb", 7)
    arrow(d, (1880, 1600), (1880, 1770), "#f97316", 7)
    arrow(d, (3200, 1600), (3200, 1770), "#e11d48", 7)

    # Bottom outputs
    text(d, (80, 1714), "Verified Business Outcomes", INK, F["xbold"](36))
    outcomes = [
        ("Customer", "Receives WhatsApp bill and Razorpay payment link only after final confirmation."),
        ("Shop Owner", "Sees pending payments, order status, customer intelligence and supplier demand."),
        ("Supplier", "Gets night procurement list when stock or unmet demand crosses threshold."),
        ("Razorpay", "Owns the payment loop for local businesses that previously lived in cash/UPI notes."),
    ]
    ox = 80
    for title, body in outcomes:
        box(d, (ox, 1790, ox + 850, 1998), title, body, "white", "#94a3b8")
        ox += 930

    d.rectangle((0, 2058, w, h), fill="#0f172a")
    text(d, (w // 2, 2118), "Razorpay AI Buildathon 2026 - Nukkad Technical Architecture", "#e2e8f0", F["semibold"](24), anchor="mm")
    img.save(DOCS / "nukkad-technical-architecture.png", quality=95)


if __name__ == "__main__":
    proposed_solution()
    technical_architecture()
    print("generated direct PNG images")
