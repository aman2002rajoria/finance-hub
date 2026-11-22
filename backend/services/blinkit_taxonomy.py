"""Blinkit product taxonomy — six primary categories with subcategories."""

from __future__ import annotations

import difflib
import re
from typing import Dict, List, Tuple

DEFAULT_CATEGORY = "Others"
DEFAULT_SUBCATEGORY = "Uncategorized"

# Primary → allowed subcategories
BLINKIT_TAXONOMY: Dict[str, List[str]] = {
    "Grocery": [
        "Dairy",
        "Fruits & Vegetables",
        "Staples & Grains",
        "Dry Fruits & Nuts",
        "Oils & Spices",
        "Bakery",
        "Eggs",
        "Meat & Seafood",
        "Frozen Food",
        "Pasta & Noodles",
        "Ready-to-Cook",
    ],
    "Snacks & Beverages": [
        "Chips & Namkeen",
        "Biscuits & Cookies",
        "Chocolates",
        "Ice Cream",
        "Soft Drinks",
        "Juices",
        "Tea & Coffee",
        "Instant Foods",
    ],
    "Household Essentials": [
        "Cleaning Supplies",
        "Laundry",
        "Dishwashing",
        "Kitchen Essentials",
        "Paper Products",
        "Storage",
    ],
    "Personal & Healthcare": [
        "Personal Care",
        "Hair Care",
        "Skin Care",
        "Oral Care",
        "Baby Care",
        "Medicines",
        "Feminine Hygiene",
    ],
    "Home & Lifestyle": [
        "Stationery",
        "Home Utilities",
        "Kitchen Tools",
        "Electrical",
        "Pet Care",
        "Gardening",
    ],
    "Others": [
        "Uncategorized",
    ],
}

PRIMARY_CATEGORIES: List[str] = list(BLINKIT_TAXONOMY.keys())

# (primary, subcategory, keywords) — earlier rules win on overlap
_RULES: List[Tuple[str, str, List[str]]] = [
    # Grocery
    ("Grocery", "Dairy", [
        "milk", "curd", "yogurt", "paneer", "cheese", "butter", "ghee", "cream",
        "lassi", "buttermilk", "dahi", "amul", "mother dairy", "nandini",
    ]),
    ("Grocery", "Fruits & Vegetables", [
        "apple", "banana", "orange", "mango", "grape", "berry", "fruit",
        "vegetable", "tomato", "onion", "potato", "carrot", "spinach", "broccoli",
        "cauliflower", "cabbage", "lettuce", "cucumber", "capsicum", "bell pepper",
        "lemon", "lime", "watermelon", "papaya", "pomegranate", "avocado",
        "coriander", "mint", "ginger", "garlic", "mushroom", "beans", "peas",
        "green chilli", "curry leaves", "cocktail mix", "herb", "basil", "parsley",
    ]),
    ("Grocery", "Dry Fruits & Nuts", [
        "cashew", "almond", "walnut", "peanut", "raisin", "pistachio", "dry fruit",
        "dry fruits", "mixed nuts", "dates", "fig", "apricot", "prune", "hazelnut",
        "macadamia", "pecan", "trail mix", "nut mix", "kaju", "badam", "akhrot",
    ]),
    ("Snacks & Beverages", "Instant Foods", [
        "ready to eat", "instant", "cup noodles", "maggi", "top ramen", "yippee",
        "frozen meal", "biryani kit", "meal kit", "heat and eat", "instant noodles",
    ]),
    ("Grocery", "Staples & Grains", [
        "rice", "dal", "lentil", "flour", "atta", "besan", "rava", "semolina",
        "oats", "cornflour", "sugar", "salt", "honey",
        "jam", "pickle", "papad", "soya sauce", "vinegar",
        "maida", "kabuli chana", "whole farm", "poha", "suji", "bajra", "jowar",
    ]),
    ("Grocery", "Pasta & Noodles", [
        "pasta", "macaroni", "vermicelli", "spaghetti", "penne", "fusilli",
        "noodle", "noodles", "lasagna", "fettuccine",
    ]),
    ("Grocery", "Oils & Spices", [
        "olive oil", "mustard oil", "sunflower oil", "cooking oil", "refined oil",
        "masala", "spice", "turmeric", "chilli powder", "cumin", "coriander powder",
        "ketchup", "mayonnaise", "soya",
        "soy sauce", "oregano", "snapin", "red chilli whole", "chilli whole",
        "mixed herbs", "methi seed", "seasoning", "peppercorn", "black pepper",
        "cardamom", "clove", "cinnamon", "bay leaf", "garam masala",
    ]),
    ("Grocery", "Bakery", [
        "bread", "bun", "pav", "cake", "pastry", "muffin", "croissant", "donut",
        "bake", "britannia", "modern bread", "brownie", "cupcake", "swiss roll",
    ]),
    ("Grocery", "Eggs", ["egg", "eggs"]),
    ("Grocery", "Meat & Seafood", [
        "chicken", "mutton", "fish", "prawn", "shrimp", "seafood", "meat",
        "sausage", "salami", "bacon",
    ]),
    ("Grocery", "Frozen Food", [
        "frozen", "mccain", "nuggets", "momos frozen", "paratha frozen",
        "paratha", "lachha paratha", "malabar paratha", "frozen snack",
        "frozen fries", "frozen pizza", "frozen peas", "frozen corn",
    ]),
    ("Grocery", "Ready-to-Cook", [
        "ready to cook", "ready-to-cook", "rtc ", "gravy mix", "instant mix",
        "idli mix", "dosa mix", "upma mix", "pulao mix", "biryani paste",
    ]),
    # Snacks & Beverages
    ("Snacks & Beverages", "Chips & Namkeen", [
        "chips", "kurkure", "lays", "namkeen", "popcorn", "nachos", "wafers",
        "makhana", "bhujia", "mixture", "haldiram", "bingo", "too yumm", "act ii",
    ]),
    ("Snacks & Beverages", "Biscuits & Cookies", [
        "biscuit", "cookie", "cracker",
    ]),
    ("Snacks & Beverages", "Chocolates", [
        "chocolate", "cadbury", "nestle", "candy", "sweet", "mithai", "laddu",
        "barfi", "gulab jamun", "fudge",
    ]),
    ("Snacks & Beverages", "Ice Cream", [
        "ice cream", "kwality", "amul ice",
    ]),
    ("Snacks & Beverages", "Soft Drinks", [
        "cola", "pepsi", "coke", "sprite", "fanta", "soft drink", "soda",
        "energy drink", "red bull",
    ]),
    ("Snacks & Beverages", "Juices", [
        "juice", "real fruit", "paper boat", "tropicana",
    ]),
    ("Snacks & Beverages", "Tea & Coffee", [
        "coffee", "tea", "green tea", "horlicks", "bournvita", "complan", "boost",
    ]),
    # Household Essentials — paper & cleaning before generic kitchen
    ("Household Essentials", "Paper Products", [
        "kitchen towel", "paper towel", "towel roll", "tissue", "toilet paper",
        "napkin", "facial tissue", "toilet roll",
    ]),
    ("Household Essentials", "Cleaning Supplies", [
        "cockroach", "roach", "mosquito", "insect", "pest", "harpic", "lizol",
        "domex", "bleach", "disinfect", "dettol", "cif", "mr. muscle",
        "floor cleaner", "toilet cleaner", "phenyl", "garbage bag", "trash bag",
        "hit spray", "hit gel", "hit fresh", "hit mini", "hit anti",
        "toilet brush",
    ]),
    ("Household Essentials", "Cleaning Supplies", [
        "detergent", "surf", "ariel", "rin", "tide", "cleaner", "cleaning",
    ]),
    ("Household Essentials", "Laundry", ["fabric softener", "rin fabric", "laundry"]),
    ("Household Essentials", "Dishwashing", [
        "dishwash", "dish wash", "vim", "dish sponge", "scrub pad", "scrubber",
        "scotch brite", "sponge scrub",
    ]),
    ("Household Essentials", "Kitchen Essentials", [
        "aluminium foil", "aluminum foil", "cling film", "cling wrap", "wrap roll",
        "foil roll", "baking paper", "butter paper",
    ]),
    ("Household Essentials", "Storage", [
        "storage box", "storage container", "food storage", "lunch box", "tiffin",
        "container set", "organizer", "zip bag", "ziplock", "zip lock",
    ]),
    # Home & Lifestyle — kitchen tools
    ("Home & Lifestyle", "Kitchen Tools", [
        "chef knife", "knife set", "mixing bowl", "chopping board", "cutting board",
        "knife", "spoon", "fork", "bowl", "plate", "mug", "glass", "bottle",
        "spatula", "whisk", "peeler", "grater", "tray", "pan", "kadai", "cooker",
        "saucepan", "frying pan", "skillet", "ladle", "tongs", "colander",
        "strainer", "measuring cup", "rolling pin", "opener", "corkscrew",
        "weighing scale", "kitchen scale", "weighing machine", "food scale",
    ]),
    # Personal & Healthcare
    ("Personal & Healthcare", "Personal Care", [
        "shampoo", "conditioner", "soap", "body wash", "deodorant", "perfume",
        "sanitary", "pad", "tampon", "cotton", "comb", "durex", "condom", "intimate",
        "nivea", "dove", "lux", "lifebuoy", "lipstick", "cosmetics", "makeup",
        "kajal", "eyeliner", "foundation", "compact", "nail polish", "mascara",
    ]),
    ("Personal & Healthcare", "Hair Care", ["hair oil", "serum", "hair mask"]),
    ("Personal & Healthcare", "Skin Care", [
        "face wash", "facewash", "moistur", "lotion", "cream", "sunscreen", "lip balm",
        "himalaya", "patanjali", "skincare kit", "skin care kit", "foxtale", "serum",
    ]),
    ("Personal & Healthcare", "Oral Care", [
        "toothpaste", "toothbrush", "mouthwash", "listerine", "razor", "shave",
    ]),
    ("Personal & Healthcare", "Baby Care", [
        "diaper", "pampers", "huggies", "baby", "infant", "johnson", "johnson's",
        "wipes baby", "baby food", "cerelac", "lactogen",
    ]),
    ("Personal & Healthcare", "Medicines", [
        "medicine", "tablet", "capsule", "syrup", "paracetamol", "crocin",
        "dolo", "bandage", "band-aid", "thermometer", "vitamin", "supplement",
        "protein", "health drink", "ors", "electral", "vicks", "cough",
        "pain relief", "antiseptic", "betadine", "cleargel", "ointment", "medicated gel",
        "antibiotic", "antacid", "drops", "inhaler",
    ]),
    ("Personal & Healthcare", "Feminine Hygiene", ["whisper", "stayfree", "feminine"]),
    # Home & Lifestyle — other
    ("Home & Lifestyle", "Stationery", [
        "pen", "pencil", "notebook", "stapler", "tape", "glue",
        "marker", "eraser", "stationery", "gift wrapping", "wrapping paper",
    ]),
    ("Home & Lifestyle", "Home Utilities", [
        "candle", "bulb", "light", "shower filter", "bath mat", "absorbent mat",
        "bucket", "mop bucket", "faucet", "tap filter", "bathroom accessory",
        "dish drying mat", "drying mat", "shower head", "hose pipe", "mug holder",
        "hanger", "clothes hanger", "doormat", "cello bucket", "frosty bucket",
    ]),
    ("Home & Lifestyle", "Electrical", [
        "charger", "cable", "usb", "earphone", "headphone", "power bank",
        "battery aa", "extension", "adapter", "electronic", "battery",
        "airdopes", "earbuds", "boat",
    ]),
    ("Home & Lifestyle", "Pet Care", [
        "pet", "dog food", "cat food", "pedigree", "whiskas", "purina",
    ]),
    ("Home & Lifestyle", "Gardening", ["garden", "plant", "seed", "fertilizer", "crochet flower", "flower bouquet"]),
    # Short-token brand / pest keywords (word-boundary only)
    ("Household Essentials", "Cleaning Supplies", ["hit", "spray"]),
]

# Map legacy flat category names → (primary, subcategory)
_LEGACY_MAP: Dict[str, Tuple[str, str]] = {
    "Dairy": ("Grocery", "Dairy"),
    "Fruits & Vegetables": ("Grocery", "Fruits & Vegetables"),
    "Snacks": ("Snacks & Beverages", "Chips & Namkeen"),
    "Beverages": ("Snacks & Beverages", "Juices"),
    "Bakery": ("Grocery", "Bakery"),
    "Frozen Food": ("Grocery", "Frozen Food"),
    "Household Essentials": ("Household Essentials", "Kitchen Essentials"),
    "Cleaning Supplies": ("Household Essentials", "Cleaning Supplies"),
    "Personal Care": ("Personal & Healthcare", "Personal Care"),
    "Baby Care": ("Personal & Healthcare", "Baby Care"),
    "Pet Supplies": ("Home & Lifestyle", "Pet Care"),
    "Medicines / Healthcare": ("Personal & Healthcare", "Medicines"),
    "Electronics": ("Home & Lifestyle", "Electrical"),
    "Kitchen Essentials": ("Household Essentials", "Kitchen Essentials"),
    "Ready to Eat": ("Snacks & Beverages", "Instant Foods"),
    "Dry Fruits": ("Grocery", "Dry Fruits & Nuts"),
    "Dry Fruits & Nuts": ("Grocery", "Dry Fruits & Nuts"),
    "Pasta & Noodles": ("Grocery", "Pasta & Noodles"),
    "Ready-to-Cook": ("Grocery", "Ready-to-Cook"),
    "Home Utilities": ("Home & Lifestyle", "Home Utilities"),
    "Meat & Seafood": ("Grocery", "Meat & Seafood"),
    "Sweets": ("Snacks & Beverages", "Chocolates"),
    "Stationery": ("Home & Lifestyle", "Stationery"),
}

# Aliases the LLM might return → valid (primary, subcategory)
_CATEGORY_ALIASES: Dict[str, Tuple[str, str]] = {
    "household": ("Household Essentials", "Kitchen Essentials"),
    "cleaning": ("Household Essentials", "Cleaning Supplies"),
    "kitchen": ("Home & Lifestyle", "Kitchen Tools"),
    "kitchen tools": ("Home & Lifestyle", "Kitchen Tools"),
    "kitchen utensils": ("Home & Lifestyle", "Kitchen Tools"),
    "cookware": ("Home & Lifestyle", "Kitchen Tools"),
    "paper": ("Household Essentials", "Paper Products"),
    "personal care": ("Personal & Healthcare", "Personal Care"),
    "healthcare": ("Personal & Healthcare", "Medicines"),
    "grocery": ("Grocery", "Staples & Grains"),
    "food": ("Grocery", "Staples & Grains"),
    "snacks": ("Snacks & Beverages", "Chips & Namkeen"),
    "beverages": ("Snacks & Beverages", "Juices"),
    "dry fruits": ("Grocery", "Dry Fruits & Nuts"),
    "dry fruits & nuts": ("Grocery", "Dry Fruits & Nuts"),
    "nuts": ("Grocery", "Dry Fruits & Nuts"),
    "pasta": ("Grocery", "Pasta & Noodles"),
    "noodles": ("Grocery", "Pasta & Noodles"),
    "ready to cook": ("Grocery", "Ready-to-Cook"),
    "ready-to-cook": ("Grocery", "Ready-to-Cook"),
    "makeup": ("Personal & Healthcare", "Personal Care"),
    "cosmetics": ("Personal & Healthcare", "Personal Care"),
    "medicine": ("Personal & Healthcare", "Medicines"),
    "medicines": ("Personal & Healthcare", "Medicines"),
    "home utilities": ("Home & Lifestyle", "Home Utilities"),
    "bathroom": ("Home & Lifestyle", "Home Utilities"),
    "uncategorized": (DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY),
    "other": (DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY),
    "others": (DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY),
}


def _keyword_matches(text: str, kw: str) -> bool:
    """Match keyword; short tokens use word boundaries to avoid false positives."""
    kw_l = kw.lower()
    if len(kw_l) <= 4 and " " not in kw_l:
        return bool(re.search(rf"\b{re.escape(kw_l)}\b", text))
    return kw_l in text


def classify_by_rules(product_name: str) -> Tuple[str, str] | None:
    """Return (primary, subcategory) if keyword rules match, else None."""
    if not product_name or not product_name.strip():
        return None
    text = product_name.lower()
    for primary, sub, keywords in _RULES:
        for kw in keywords:
            if _keyword_matches(text, kw):
                return primary, sub
    return None


def normalize_legacy(category: str | None, subcategory: str | None = None) -> Tuple[str, str]:
    """Map old flat categories to the new hierarchy."""
    if category in BLINKIT_TAXONOMY:
        sub = subcategory if subcategory in BLINKIT_TAXONOMY[category] else DEFAULT_SUBCATEGORY
        return category, sub
    if category and category in _LEGACY_MAP:
        return _LEGACY_MAP[category]
    return DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY


def is_valid_pair(category: str, subcategory: str | None) -> bool:
    subs = BLINKIT_TAXONOMY.get(category)
    if not subs:
        return False
    return (subcategory or DEFAULT_SUBCATEGORY) in subs


def _closest_label(label: str, choices: List[str]) -> str:
    if not choices:
        return label
    match = difflib.get_close_matches(label, choices, n=1, cutoff=0.5)
    return match[0] if match else choices[0]


def resolve_to_valid_pair(category: str, subcategory: str | None) -> Tuple[str, str]:
    """Map arbitrary LLM output to the closest valid taxonomy pair."""
    cat = (category or "").strip()
    sub = (subcategory or "").strip()

    if cat.lower() in _CATEGORY_ALIASES:
        return _CATEGORY_ALIASES[cat.lower()]

    if cat in BLINKIT_TAXONOMY:
        subs = BLINKIT_TAXONOMY[cat]
        if sub in subs:
            return cat, sub
        if sub:
            return cat, _closest_label(sub, subs)
        return cat, subs[0]

    # Try matching category name fuzzily across primaries
    closest_cat = _closest_label(cat, PRIMARY_CATEGORIES)
    if closest_cat and difflib.SequenceMatcher(None, cat.lower(), closest_cat.lower()).ratio() >= 0.55:
        subs = BLINKIT_TAXONOMY[closest_cat]
        if sub in subs:
            return closest_cat, sub
        if sub:
            return closest_cat, _closest_label(sub, subs)
        return closest_cat, subs[0]

    # Try matching subcategory across all primaries
    if sub:
        for primary, subs in BLINKIT_TAXONOMY.items():
            if sub in subs:
                return primary, sub
            close = difflib.get_close_matches(sub, subs, n=1, cutoff=0.6)
            if close:
                return primary, close[0]

    return DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY


def taxonomy_prompt() -> str:
    lines = [
        "You are an expert retail product classifier for Indian quick-commerce groceries.",
        "",
        "Classify every product into exactly ONE category and ONE subcategory from the taxonomy below.",
        "",
        "=== CRITICAL: AVOID Others ===",
        "Others > Uncategorized must be EXTREMELY RARE — use it only when the product is truly",
        "impossible to understand or has no reasonable fit anywhere in the taxonomy.",
        "",
        "An approximate but useful classification (80–90% accurate) is ALWAYS preferred over Others.",
        "When uncertain, choose the closest valid category/subcategory — never default to Others.",
        "",
        "=== Priority order ===",
        "1. Identify what the product fundamentally IS (its core purpose and use).",
        "2. Ignore branding, HSN codes, SKU codes, sizes, colors, quantities, promotional text,",
        "   and packaging type (Packet, Box, Pouch, Bottle, Punnet, Jar, etc.).",
        "3. Choose the closest matching category and subcategory using semantic understanding.",
        "4. If still uncertain, pick the best parent category rather than Others.",
        "5. Return Others > Uncategorized ONLY as a last resort when no reasonable fit exists.",
        "",
        "=== Classification rules ===",
        "- Brand names must NEVER affect classification.",
        "- Packaging must NEVER affect classification.",
        "- Infer purpose from the product name, not exact keyword matching.",
        "- Prefer a related subcategory over Others even if the match is imperfect.",
        "- Herbs and fresh aromatics → Grocery > Fruits & Vegetables.",
        "- Dry nuts and dried fruit → Grocery > Dry Fruits & Nuts.",
        "- Spices, seasonings, and dried herbs → Grocery > Oils & Spices.",
        "- Dry pasta and noodles → Grocery > Pasta & Noodles; instant/cup noodles → Snacks & Beverages > Instant Foods.",
        "- Ready-to-cook mixes and meal kits → Grocery > Ready-to-Cook or Snacks & Beverages > Instant Foods.",
        "- Frozen parathas, frozen snacks, frozen meals → Grocery > Frozen Food.",
        "- Cakes, brownies, muffins, pastries → Grocery > Bakery.",
        "- Kitchen utensils, cookware, knives, scales → Home & Lifestyle > Kitchen Tools.",
        "- Buckets, bath mats, shower filters, faucet accessories → Home & Lifestyle > Home Utilities.",
        "- Lipstick, makeup, cosmetics → Personal & Healthcare > Personal Care.",
        "- Skincare kits and face/body care → Personal & Healthcare > Skin Care.",
        "- Medicines, medicated gels, ointments → Personal & Healthcare > Medicines.",
        "- Kitchen towels, foil, cling wrap → Household Essentials.",
        "- Cleaning sprays, floor cleaners, insect killers → Household Essentials > Cleaning Supplies.",
        "",
        "=== Examples ===",
        "- Cashews, Almonds, Walnuts, Raisins, Pistachios, Peanuts, Mixed Nuts → Grocery > Dry Fruits & Nuts",
        "- Curry Leaves, Coriander, Mint, Fresh Herbs → Grocery > Fruits & Vegetables",
        "- Oregano, Mixed Herbs, Methi Seeds, Cumin, Pepper, Seasonings → Grocery > Oils & Spices",
        "- Pasta, Macaroni, Vermicelli, Spaghetti → Grocery > Pasta & Noodles",
        "- Maggi, Cup Noodles, Instant Noodles → Snacks & Beverages > Instant Foods",
        "- Ready-to-cook Parathas, Frozen Snacks, Frozen Fries → Grocery > Frozen Food",
        "- Brownies, Cakes, Muffins, Pastries → Grocery > Bakery",
        "- Kitchen Weighing Scale, Chef Knife, Mixing Bowl → Home & Lifestyle > Kitchen Tools",
        "- Buckets, Bath Mats, Dish Drying Mats, Shower Filters → Home & Lifestyle > Home Utilities",
        "- Lipstick, Makeup, Cosmetics → Personal & Healthcare > Personal Care",
        "- Skin Care Kit, Face Wash, Moisturizer → Personal & Healthcare > Skin Care",
        "- Medicines, Medicated Gels, Ointments → Personal & Healthcare > Medicines",
        "- Kitchen towel, tissue roll → Household Essentials > Paper Products",
        "- Cockroach spray, floor cleaner → Household Essentials > Cleaning Supplies",
        "- Aluminium foil, cling wrap → Household Essentials > Kitchen Essentials",
        "",
        "Valid taxonomy (use EXACT names):",
    ]
    for primary, subs in BLINKIT_TAXONOMY.items():
        if primary == DEFAULT_CATEGORY:
            lines.append(f"  {primary}: {', '.join(subs)}  ← LAST RESORT ONLY")
        else:
            lines.append(f"  {primary}: {', '.join(subs)}")
    lines.extend([
        "",
        "Return ONLY valid JSON — no markdown, no explanation.",
        "",
        "Format:",
        "[",
        '  {"product": "...", "category": "...", "subcategory": "..."}',
        "]",
    ])
    return "\n".join(lines)
