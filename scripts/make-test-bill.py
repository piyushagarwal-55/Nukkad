"""
Generate supplier-bill fixtures for testing the bill agent.

    python scripts/make-test-bill.py            # all four
    python scripts/make-test-bill.py messy      # just one

Four fixtures, each exercising a different path through the graph:

  printed   crisp typed bill, matches the seeded catalogue by case only.
            The old exact-name matcher created duplicates here.
  messy     handwriting, jittered baselines, rotation, blur. Arithmetic
            all reconciles, so the verify node passes it in one read.
  bad-maths handwriting where one line's amount does NOT equal qty x rate.
            Forces verify to spend a second vision call and escalate.
  south     South Indian names, to exercise the Tamil half of the corpus.

These are synthetic: a handwriting FONT is cleaner than a real pen, so
passing here is a lower bound on difficulty, not proof. Photograph a real
bill before believing the numbers.

Needs Pillow:  pip install pillow
Output:        media/  (gitignored)
"""
import io
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media")

# Windows ships both; fall back to whatever exists so this runs elsewhere.
HAND = [r"C:\Windows\Fonts\Inkfree.ttf", r"C:\Windows\Fonts\LHANDW.TTF",
        "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
TYPED = [r"C:\Windows\Fonts\arial.ttf", "/Library/Fonts/Arial.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
BOLD = [r"C:\Windows\Fonts\arialbd.ttf", "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def handwritten(name, rows, bill_no, seed):
    """Pen on ruled paper: uneven baselines, varying size, a slight skew."""
    random.seed(seed)
    ink = (20, 30, 110)
    img = Image.new("RGB", (900, 180 + 42 * len(rows)), (252, 250, 240))
    d = ImageDraw.Draw(img)

    for y in range(150, img.height - 20, 42):
        d.line((50, y, 850, y), fill=(226, 223, 211))

    d.text((60, 34), "Balaji Kirana Bhandar", font=font(HAND, 38), fill=ink)
    d.text((60, 84), f"Bill No {bill_no}        Dt 27/8/26", font=font(HAND, 26), fill=ink)

    y = 160
    for item, qty, rate, amt in rows:
        dy = random.randint(-4, 4)
        sz = random.choice([27, 29, 30])
        d.text((62, y + dy), item, font=font(HAND, sz), fill=ink)
        d.text((560, y + dy + random.randint(-3, 3)), qty, font=font(HAND, sz), fill=ink)
        d.text((650, y + dy + random.randint(-3, 3)), rate, font=font(HAND, sz), fill=ink)
        d.text((760, y + dy + random.randint(-3, 3)), amt, font=font(HAND, sz), fill=ink)
        y += 42

    img = img.rotate(-1.1, resample=Image.BICUBIC, fillcolor=(252, 250, 240))
    img = img.filter(ImageFilter.GaussianBlur(0.4))
    img.save(os.path.join(OUT, name))
    return name


def typed(name, header, city, rows, bill_no, gst=True):
    """A printed wholesale invoice, with the tax rows a parser must skip."""
    h = 300 + 40 * len(rows) + (120 if gst else 40)
    img = Image.new("RGB", (900, h), "white")
    d = ImageDraw.Draw(img)

    d.text((40, 30), header, font=font(BOLD, 30), fill="black")
    d.text((40, 72), city, font=font(TYPED, 14), fill="#333")
    d.line((40, 118, 860, 118), fill="black", width=2)
    d.text((40, 132), "TAX INVOICE", font=font(BOLD, 16), fill="black")
    d.text((580, 132), f"Bill No: {bill_no}", font=font(TYPED, 14), fill="black")
    d.text((580, 156), "Date: 27-08-2026", font=font(TYPED, 14), fill="black")
    d.text((40, 156), "To: Sunita Kirana Store", font=font(TYPED, 14), fill="black")

    y = 200
    d.rectangle((40, y, 860, y + 32), fill="#e8e8e8")
    for x, t in ((52, "S.NO"), (110, "PARTICULARS"), (540, "QTY"), (640, "RATE"), (770, "AMOUNT")):
        d.text((x, y + 8), t, font=font(BOLD, 13), fill="black")

    y += 32
    total = 0.0
    for i, (item, qty, rate, amt) in enumerate(rows, 1):
        d.line((40, y, 860, y), fill="#bbb")
        d.text((58, y + 11), str(i), font=font(TYPED, 13), fill="black")
        d.text((110, y + 11), item, font=font(TYPED, 13), fill="black")
        d.text((546, y + 11), qty, font=font(TYPED, 13), fill="black")
        d.text((640, y + 11), rate, font=font(TYPED, 13), fill="black")
        d.text((770, y + 11), amt, font=font(TYPED, 13), fill="black")
        total += float(amt)
        y += 40

    d.line((40, y, 860, y), fill="black", width=2)
    y += 12
    lines = [("Sub Total", total)]
    if gst:
        lines += [("CGST 2.5%", total * 0.025), ("SGST 2.5%", total * 0.025)]
    lines += [("GRAND TOTAL", total * (1.05 if gst else 1.0))]
    for label, val in lines:
        b = label == "GRAND TOTAL"
        d.text((610, y), label, font=font(BOLD if b else TYPED, 14), fill="black")
        d.text((770, y), f"{val:.2f}", font=font(BOLD if b else TYPED, 14), fill="black")
        y += 26

    img.save(os.path.join(OUT, name))
    return name


NIRMALA = [r"C:\Windows\Fonts\Nirmala.ttc"]


def devanagari(name, rows, total):
    """Mirrors a real bill: quantity + Devanagari description + amount only.

    The Rate column is drawn but left BLANK, which is exactly what forces
    the repair node to solve for it. Note that PIL has no Raqm here, so
    conjuncts render imperfectly -- fine as a fixture, not a substitute for
    photographing real paper.
    """
    random.seed(3)
    ink = (25, 35, 115)
    img = Image.new("RGB", (880, 150 + 40 * len(rows) + 90), (250, 248, 240))
    d = ImageDraw.Draw(img)
    dev = lambda sz: font(NIRMALA + TYPED, sz)

    d.rectangle((40, 40, 840, 88), outline=(120, 90, 70), width=2)
    for x, t in ((52, "Quantity"), (190, "Description of Product/Services"),
                 (560, "Rate"), (700, "Amount")):
        d.text((x, 56), t, font=font(TYPED, 15), fill=(60, 50, 40))
    for x in (180, 550, 690):
        d.line((x, 40, x, 140 + 40 * len(rows)), fill=(150, 120, 100))

    y = 100
    for qty_text, desc, amt in rows:
        d.line((40, y, 840, y), fill=(190, 165, 145))
        dy = random.randint(-3, 3)
        d.text((52, y + 8 + dy), qty_text, font=dev(22), fill=ink)
        d.text((196, y + 6 + dy), desc, font=dev(26), fill=ink)
        d.text((700, y + 8 + dy), "{:,}/-".format(amt), font=dev(23), fill=ink)
        y += 40

    d.line((40, y, 840, y), fill=(120, 90, 70), width=2)
    d.text((400, y + 14), "Total Assessable Value", font=font(TYPED, 15), fill=(60, 50, 40))
    d.text((700, y + 10), "{:,}/-".format(total), font=dev(25), fill=ink)

    img = img.rotate(-0.7, resample=Image.BICUBIC, fillcolor=(250, 248, 240))
    img = img.filter(ImageFilter.GaussianBlur(0.35))
    img.save(os.path.join(OUT, name))
    return name


# quantity cell, Devanagari description, amount in rupees
DEVANAGARI_ROWS = [
    ("1000kg", "\u0906\u091f\u093e", 27400),
    ("200kg", "\u091a\u093e\u0935\u0932", 6400),
    ("90kg", "\u091a\u0928\u093e \u0926\u093e\u0932", 5940),
    ("90kg", "\u092e\u0938\u0942\u0930 \u0926\u093e\u0932", 7290),
    ("90kg", "\u0905\u0930\u0939\u0930", 8550),
    ("200pcs", "\u0939\u0932\u094d\u0926\u0940", 3000),
    ("200pcs", "\u0927\u0928\u093f\u092f\u093e", 3000),
    ("200pcs", "\u092e\u093f\u0930\u094d\u091a", 3000),
    ("200", "\u0938\u0942\u091c\u0940", 2000),
    ("200", "\u0938\u093e\u092c\u0941\u0928", 2000),
    ("8 \u092a\u0947\u091f\u0940", "\u0924\u0947\u0932 500ml", 10560),
]

FIXTURES = {
    # Devanagari, handwritten-style, and the Rate column deliberately blank
    "devanagari": lambda: devanagari("bill-devanagari.png", DEVANAGARI_ROWS, 79140),

    # ALL CAPS against a title-case catalogue: the case-only match
    "printed": lambda: typed(
        "bill-printed.png", "SHREE BALAJI TRADERS",
        "Ramganj Bazaar, Jaipur 302002  ·  GSTIN 08AABCS1429B1ZQ",
        [("AASHIRVAAD ATTA 5KG", "12", "268.00", "3216.00"),
         ("AMUL BUTTER 500GM", "10", "258.00", "2580.00"),
         ("CHANA DAL 1KG", "25", "88.00", "2200.00"),
         ("MDH DEGGI MIRCH 100G", "8", "72.00", "576.00"),
         ("AMUL TAAZA MILK 1L PCH", "40", "31.00", "1240.00")], "4471"),

    # every line reconciles, so verify passes in a single read
    "messy": lambda: handwritten(
        "bill-handwritten.png",
        [("Atta Ashirvad 5kg", "12", "268", "3216"),
         ("Sugar", "25", "46", "1150"),
         ("Toor dal", "10", "142", "1420"),
         ("Amul butter 500g", "6", "258", "1548"),
         ("Chai patti 500g", "8", "270", "2160")], "118", seed=7),

    # line 3: 10 x 142 = 1420, but the paper says 1720. verify must catch it.
    "bad-maths": lambda: handwritten(
        "bill-handwritten-bad-maths.png",
        [("Atta Ashirvad 5kg", "12", "268", "3216"),
         ("Sugar", "25", "46", "1150"),
         ("Toor dal", "10", "142", "1720"),
         ("Amul butter 500g", "6", "258", "1548")], "119", seed=11),

    "south": lambda: typed(
        "bill-south.png", "SRI MURUGAN STORES",
        "Wholesale Provisions · Coimbatore 641001",
        [("IDHAYAM GINGELLY OIL 1L", "6", "310.00", "1860.00"),
         ("IDLI RICE PONNI 5KG", "10", "290.00", "2900.00"),
         ("MTR RASAM POWDER 100G", "24", "48.00", "1152.00"),
         ("TAMARIND SEEDLESS 500G", "12", "96.00", "1152.00")], "2291", gst=False),
}

def truth():
    """Ground truth for the eval harness, amounts in paise.

    Rates for the Devanagari bill are DERIVED (amount / quantity), because
    the paper leaves that column blank. That is the whole point: without
    the repair node those eleven rates are unrecoverable, and the ablation
    ladder is what makes that visible rather than asserted.
    """
    def rows(rs):
        out = []
        for item, qty, rate, amt in rs:
            q = float(qty)
            a = round(float(amt) * 100)
            out.append({
                "name": item,
                "qty": q,
                "ratePaise": round(a / q) if rate is None else round(float(rate) * 100),
                "amountPaise": a,
            })
        return out

    # what a correct transliteration should produce, in order
    roman = ["atta", "chawal", "chana dal", "masoor dal", "arhar", "haldi",
             "dhaniya", "mirch", "suji", "sabun", "tel"]
    dev = [(desc, qty.replace("kg", "").replace("pcs", "").split()[0], None, amt)
           for qty, desc, amt in DEVANAGARI_ROWS]

    return {
        "bill-printed.png": {"totalPaise": None, "lines": rows([
            ("AASHIRVAAD ATTA 5KG", "12", "268.00", "3216.00"),
            ("AMUL BUTTER 500GM", "10", "258.00", "2580.00"),
            ("CHANA DAL 1KG", "25", "88.00", "2200.00"),
            ("MDH DEGGI MIRCH 100G", "8", "72.00", "576.00"),
            ("AMUL TAAZA MILK 1L PCH", "40", "31.00", "1240.00")])},
        "bill-handwritten.png": {"totalPaise": None, "lines": rows([
            ("Atta Ashirvad 5kg", "12", "268", "3216"),
            ("Sugar", "25", "46", "1150"),
            ("Toor dal", "10", "142", "1420"),
            ("Amul butter 500g", "6", "258", "1548"),
            ("Chai patti 500g", "8", "270", "2160")])},
        "bill-south.png": {"totalPaise": None, "lines": rows([
            ("IDHAYAM GINGELLY OIL 1L", "6", "310.00", "1860.00"),
            ("IDLI RICE PONNI 5KG", "10", "290.00", "2900.00"),
            ("MTR RASAM POWDER 100G", "24", "48.00", "1152.00"),
            ("TAMARIND SEEDLESS 500G", "12", "96.00", "1152.00")])},
        "bill-devanagari.png": {
            "totalPaise": 7914000,
            "lines": [dict(r, roman=roman[i]) for i, r in enumerate(rows(dev))],
        },
    }


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    want = sys.argv[1:] or list(FIXTURES)
    for key in want:
        if key not in FIXTURES:
            print(f"unknown fixture: {key}. one of: {', '.join(FIXTURES)}")
            raise SystemExit(1)
        print("wrote media/" + FIXTURES[key]())

    with io.open(os.path.join(OUT, "fixtures.json"), "w", encoding="utf-8") as fh:
        json.dump(truth(), fh, indent=2, ensure_ascii=False)
    print("wrote media/fixtures.json")
