"""
Photographed SHOPPING LISTS, which are not bills.

A customer sending a picture of the paper on their kitchen counter is the
most natural thing on a WhatsApp ordering line, and it is a different
document from a supplier invoice: no rates, no total, no GST. Nothing to
reconcile, everything to resolve.

The three here are the shapes that actually turn up:

  list-plain      the one from the live sandbox, ruled paper, English
  list-hinglish   Roman Hinglish, which is how most people write a list
  list-messy      a struck-through line, a blank quantity, a bent page

The struck-through line is the important one. A model that reads it back
orders something the customer decided against, and there is no way for
them to tell from the confirm card that it was ever crossed out.

    python scripts/make-shopping-list.py
"""
import os, json, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

random.seed(11)
OUT = "media"
HAND = [r"C:\Windows\Fonts\Inkfree.ttf", r"C:\Windows\Fonts\LHANDW.TTF",
        "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def paper(w, h, tint=(253, 251, 243)):
    img = Image.new("RGB", (w, h), tint)
    d = ImageDraw.Draw(img)
    # ruled lines, faint, like a notebook page
    for y in range(120, h - 40, 62):
        d.line([(40, y), (w - 40, y)], fill=(206, 216, 228), width=2)
    return img, d


def photographed(img):
    """A list is PHOTOGRAPHED, never scanned. Soften and shade it."""
    img = img.rotate(random.uniform(-1.6, 1.6), expand=True, fillcolor=(250, 248, 240))
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    w, h = img.size
    shade = Image.new("L", (w, h), 0)
    sd = ImageDraw.Draw(shade)
    for i in range(28):
        sd.rectangle([0, 0, w, h - i * (h // 34)], fill=int(i * 1.5))
    return Image.composite(Image.new("RGB", (w, h), (150, 148, 140)), img, shade.point(lambda v: v // 3))


def write(name, title, rows, strike=()):
    img, d = paper(760, 180 + 62 * len(rows))
    ink = (28, 42, 90)
    d.text((52, 46), title, font=font(HAND, 40), fill=(150, 40, 60))

    y = 132
    for i, (item, qty) in enumerate(rows):
        d.text((60, y), item, font=font(HAND, 36), fill=ink)
        if qty:
            d.text((470, y), qty, font=font(HAND, 36), fill=ink)
        if i in strike:
            d.line([(52, y + 22), (620, y + 20)], fill=(150, 40, 60), width=3)
        y += 62

    photographed(img).save(os.path.join(OUT, f"{name}.png"))
    return {"file": f"{name}.png",
            "want": [r[0] for i, r in enumerate(rows) if i not in strike]}


truth = [
    # the list from the live WhatsApp sandbox, transcribed
    write("list-plain", "Shopping", [
        ("Flour", "5 kg"), ("Rice", "5 kg"), ("Cooking oil", "1 L"),
        ("Sugar", "1 kg"), ("Tea", "500 g"),
    ]),
    # how a list actually gets written in an Indian kitchen
    write("list-hinglish", "Saman", [
        ("Atta", "5 kg"), ("Chawal", "2 kg"), ("Tel", "1 L"),
        ("Cheeni", "1 kg"), ("Chai patti", "250 g"), ("Namak", "1 kg"),
    ]),
    # struck-through line, missing quantity, and a brand written in
    write("list-messy", "List", [
        ("Aashirvaad atta", "10 kg"), ("Maggi", ""), ("Toor dal", "2 kg"),
        ("Colgate", "1"), ("Surf excel", "1 kg"),
    ], strike=(1,)),
]

with open(os.path.join(OUT, "list-fixtures.json"), "w", encoding="utf-8") as f:
    json.dump(truth, f, indent=1)

for t in truth:
    print(f"  {t['file']:<22} {len(t['want'])} wanted: {', '.join(t['want'])}")
