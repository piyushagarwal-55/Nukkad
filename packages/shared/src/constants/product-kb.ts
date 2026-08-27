/**
 * The product knowledge base: the retrieval corpus behind alias generation.
 *
 * A supplier bill prints the TRADE's name for a product. A customer says
 * something else entirely, and that word is never on the bill:
 *
 *     bill says      "AASHIRVAAD ATTA 5KG"
 *     customer says  "atta bhejo" / "gehu ka atta" / "chakki wala atta"
 *
 * Ask a model cold for those local names and it invents plausible-looking
 * ones nobody actually says. Give it the real names for the nearest known
 * products and it stays on the ground. That is the whole point of this
 * file: alias generation RETRIEVES from here instead of free-recalling.
 *
 * Subnames are ordered most-said first, lowercase Roman Hinglish, and
 * deliberately include romanisation variants (atta/aata/ata) because that
 * is how people actually type and how ASR actually transcribes.
 *
 * Pack size is never a subname. Quantity is parsed separately.
 */

export interface KbEntry {
  canonical: string;
  brand?: string;
  category: string;
  unit: string;
  subnames: string[];
}

export const PRODUCT_KB: KbEntry[] = [
  // ---------------------------------------------------------- flour
  { canonical: 'Whole Wheat Atta', category: 'flour', unit: 'kg',
    subnames: ['atta', 'aata', 'ata', 'gehu ka atta', 'gehun atta', 'chakki atta', 'chakki wala atta', 'wheat flour'] },
  { canonical: 'Whole Wheat Atta', brand: 'Aashirvaad', category: 'flour', unit: 'kg',
    subnames: ['aashirvaad atta', 'ashirwad atta', 'ashirvad ka atta', 'atta', 'aata'] },
  { canonical: 'Maida', category: 'flour', unit: 'kg',
    subnames: ['maida', 'mainda', 'refined atta', 'safed atta'] },
  { canonical: 'Besan', category: 'flour', unit: 'kg',
    subnames: ['besan', 'besun', 'chane ka atta', 'gram flour'] },
  { canonical: 'Suji', category: 'flour', unit: 'kg',
    subnames: ['suji', 'sooji', 'rava', 'rawa', 'semolina'] },
  { canonical: 'Bajra Atta', category: 'flour', unit: 'kg',
    subnames: ['bajra atta', 'bajre ka atta', 'millet flour'] },
  { canonical: 'Makki Atta', category: 'flour', unit: 'kg',
    subnames: ['makki atta', 'makke ka atta', 'corn flour', 'maize flour'] },

  // ----------------------------------------------------------- rice
  { canonical: 'Basmati Rice', category: 'rice', unit: 'kg',
    subnames: ['basmati', 'basmati chawal', 'chawal', 'chaval', 'lamba chawal', 'rice'] },
  { canonical: 'Basmati Rice', brand: 'India Gate', category: 'rice', unit: 'kg',
    subnames: ['india gate', 'india gate chawal', 'basmati', 'chawal'] },
  { canonical: 'Sona Masoori Rice', category: 'rice', unit: 'kg',
    subnames: ['sona masoori', 'sona masuri', 'chawal', 'chaval'] },
  { canonical: 'Poha', category: 'rice', unit: 'kg',
    subnames: ['poha', 'pauva', 'chiwda', 'chura', 'flattened rice'] },
  { canonical: 'Sabudana', category: 'rice', unit: 'kg',
    subnames: ['sabudana', 'sabudane', 'sago', 'tapioca'] },

  // ---------------------------------------------------------- pulses
  { canonical: 'Toor Dal', category: 'pulses', unit: 'kg',
    subnames: ['toor dal', 'tur dal', 'arhar dal', 'arhar ki dal', 'peeli dal', 'dal'] },
  { canonical: 'Moong Dal', category: 'pulses', unit: 'kg',
    subnames: ['moong dal', 'mung dal', 'moong ki dal', 'dhuli moong', 'dal'] },
  { canonical: 'Chana Dal', category: 'pulses', unit: 'kg',
    subnames: ['chana dal', 'chane ki dal', 'chana ki dal', 'dal'] },
  { canonical: 'Masoor Dal', category: 'pulses', unit: 'kg',
    subnames: ['masoor dal', 'masur dal', 'laal dal', 'red dal', 'dal'] },
  { canonical: 'Urad Dal', category: 'pulses', unit: 'kg',
    subnames: ['urad dal', 'urd dal', 'kaali dal', 'maa ki dal'] },
  { canonical: 'Rajma', category: 'pulses', unit: 'kg',
    subnames: ['rajma', 'raajma', 'kidney beans', 'laal rajma'] },
  { canonical: 'Kabuli Chana', category: 'pulses', unit: 'kg',
    subnames: ['kabuli chana', 'chole', 'chhole', 'safed chana', 'chickpeas'] },
  { canonical: 'Kala Chana', category: 'pulses', unit: 'kg',
    subnames: ['kala chana', 'kaala chana', 'black chana', 'chana'] },
  { canonical: 'Lobia', category: 'pulses', unit: 'kg',
    subnames: ['lobia', 'chawli', 'black eyed peas'] },

  // ------------------------------------------------------------- oil
  { canonical: 'Sunflower Oil', category: 'oil', unit: 'l',
    subnames: ['tel', 'refined', 'refined tel', 'sunflower tel', 'peela tel', 'peela wala tel', 'khana pakane ka tel'] },
  { canonical: 'Sunflower Oil', brand: 'Fortune', category: 'oil', unit: 'l',
    subnames: ['fortune tel', 'fortune oil', 'refined', 'tel'] },
  { canonical: 'Mustard Oil', category: 'oil', unit: 'l',
    subnames: ['sarson ka tel', 'sarso tel', 'sarson tel', 'kadwa tel', 'mustard oil'] },
  { canonical: 'Groundnut Oil', category: 'oil', unit: 'l',
    subnames: ['mungfali ka tel', 'moongfali tel', 'groundnut oil', 'peanut oil'] },
  { canonical: 'Rice Bran Oil', category: 'oil', unit: 'l',
    subnames: ['rice bran', 'rice bran tel', 'tel'] },
  { canonical: 'Desi Ghee', category: 'oil', unit: 'kg',
    subnames: ['ghee', 'ghi', 'desi ghee', 'gaay ka ghee', 'shudh ghee'] },
  { canonical: 'Vanaspati', category: 'oil', unit: 'kg',
    subnames: ['vanaspati', 'dalda', 'banaspati'] },

  // ------------------------------------------------- sugar, salt, gud
  { canonical: 'Sugar', category: 'staple', unit: 'kg',
    subnames: ['cheeni', 'chini', 'chinni', 'shakkar', 'shakar', 'sugar'] },
  { canonical: 'Iodised Salt', category: 'staple', unit: 'kg',
    subnames: ['namak', 'nimak', 'salt', 'namk'] },
  { canonical: 'Iodised Salt', brand: 'Tata', category: 'staple', unit: 'kg',
    subnames: ['tata namak', 'tata salt', 'namak'] },
  { canonical: 'Rock Salt', category: 'staple', unit: 'kg',
    subnames: ['sendha namak', 'kala namak', 'rock salt'] },
  { canonical: 'Jaggery', category: 'staple', unit: 'kg',
    subnames: ['gud', 'gur', 'jaggery', 'gud ki dali'] },

  // -------------------------------------------------------- tea, coffee
  { canonical: 'Tea Leaves', category: 'beverage', unit: 'g',
    subnames: ['chai', 'chai patti', 'chaay patti', 'chay patti', 'patti', 'tea'] },
  { canonical: 'Tea Leaves', brand: 'Tata Tea', category: 'beverage', unit: 'g',
    subnames: ['tata chai', 'tata tea', 'chai patti', 'chai'] },
  { canonical: 'Tea Leaves', brand: 'Red Label', category: 'beverage', unit: 'g',
    subnames: ['red label', 'red label chai', 'chai patti'] },
  { canonical: 'Instant Coffee', category: 'beverage', unit: 'g',
    subnames: ['coffee', 'kaafi', 'nescafe', 'coffee powder'] },
  { canonical: 'Malted Health Drink', brand: 'Bournvita', category: 'beverage', unit: 'g',
    subnames: ['bournvita', 'bornvita', 'health drink'] },
  { canonical: 'Malted Health Drink', brand: 'Horlicks', category: 'beverage', unit: 'g',
    subnames: ['horlicks', 'harlicks', 'health drink'] },

  // ---------------------------------------------------------- spices
  { canonical: 'Turmeric Powder', category: 'spice', unit: 'g',
    subnames: ['haldi', 'haldi powder', 'turmeric', 'peeli haldi'] },
  { canonical: 'Red Chilli Powder', category: 'spice', unit: 'g',
    subnames: ['mirch', 'lal mirch', 'laal mirch', 'mirchi', 'chilli powder', 'mirch powder'] },
  { canonical: 'Coriander Powder', category: 'spice', unit: 'g',
    subnames: ['dhaniya', 'dhania powder', 'dhaniya powder', 'coriander powder'] },
  { canonical: 'Cumin Seeds', category: 'spice', unit: 'g',
    subnames: ['jeera', 'zeera', 'jira', 'cumin'] },
  { canonical: 'Garam Masala', category: 'spice', unit: 'g',
    subnames: ['garam masala', 'masala', 'garm masala'] },
  { canonical: 'Mustard Seeds', category: 'spice', unit: 'g',
    subnames: ['rai', 'sarson', 'sarso', 'mustard seeds'] },
  { canonical: 'Fenugreek Seeds', category: 'spice', unit: 'g',
    subnames: ['methi', 'methi dana', 'fenugreek'] },
  { canonical: 'Asafoetida', category: 'spice', unit: 'g',
    subnames: ['hing', 'heeng', 'asafoetida'] },
  { canonical: 'Black Pepper', category: 'spice', unit: 'g',
    subnames: ['kali mirch', 'kaali mirch', 'black pepper', 'gol mirch'] },
  { canonical: 'Green Cardamom', category: 'spice', unit: 'g',
    subnames: ['elaichi', 'ilaichi', 'chhoti elaichi', 'cardamom'] },
  { canonical: 'Cloves', category: 'spice', unit: 'g',
    subnames: ['laung', 'lavang', 'cloves'] },
  { canonical: 'Cinnamon', category: 'spice', unit: 'g',
    subnames: ['dalchini', 'daalchini', 'cinnamon'] },
  { canonical: 'Bay Leaf', category: 'spice', unit: 'g',
    subnames: ['tej patta', 'tejpatta', 'bay leaf'] },
  { canonical: 'Carom Seeds', category: 'spice', unit: 'g',
    subnames: ['ajwain', 'ajvain', 'carom'] },
  { canonical: 'Chaat Masala', category: 'spice', unit: 'g',
    subnames: ['chaat masala', 'chat masala'] },
  { canonical: 'Sambar Powder', category: 'spice', unit: 'g',
    subnames: ['sambar masala', 'sambhar powder', 'sambar powder'] },

  // ----------------------------------------------------------- dairy
  { canonical: 'Toned Milk', category: 'dairy', unit: 'l',
    subnames: ['doodh', 'dudh', 'milk', 'toned milk'] },
  { canonical: 'Curd', category: 'dairy', unit: 'kg',
    subnames: ['dahi', 'curd', 'yogurt', 'dahee'] },
  { canonical: 'Paneer', category: 'dairy', unit: 'g',
    subnames: ['paneer', 'panir', 'cottage cheese'] },
  { canonical: 'Butter', category: 'dairy', unit: 'g',
    subnames: ['makkhan', 'makhan', 'butter', 'amul butter'] },
  { canonical: 'Cheese Slices', category: 'dairy', unit: 'g',
    subnames: ['cheese', 'cheez', 'cheese slice'] },
  { canonical: 'Condensed Milk', category: 'dairy', unit: 'g',
    subnames: ['milkmaid', 'condensed milk'] },

  // -------------------------------------------------- bakery and eggs
  { canonical: 'Bread', category: 'bakery', unit: 'pc',
    subnames: ['bread', 'double roti', 'bred', 'pav'] },
  { canonical: 'Eggs', category: 'bakery', unit: 'dz',
    subnames: ['ande', 'anda', 'egg', 'eggs'] },
  { canonical: 'Rusk', category: 'bakery', unit: 'g',
    subnames: ['rusk', 'toast', 'suji toast'] },

  // ---------------------------------------------------------- snacks
  { canonical: 'Glucose Biscuits', brand: 'Parle-G', category: 'snacks', unit: 'g',
    subnames: ['parle g', 'parle-g', 'parle biscuit', 'biscuit', 'biskut'] },
  { canonical: 'Marie Biscuits', category: 'snacks', unit: 'g',
    subnames: ['marie', 'mari biscuit', 'biscuit'] },
  { canonical: 'Instant Noodles', brand: 'Maggi', category: 'snacks', unit: 'g',
    subnames: ['maggi', 'magi', 'noodles', 'maggie'] },
  { canonical: 'Namkeen Mixture', category: 'snacks', unit: 'g',
    subnames: ['namkeen', 'mixture', 'namkin', 'sev'] },
  { canonical: 'Potato Chips', category: 'snacks', unit: 'g',
    subnames: ['chips', 'lays', 'wafers'] },
  { canonical: 'Papad', category: 'snacks', unit: 'g',
    subnames: ['papad', 'papadum', 'appalam'] },
  { canonical: 'Vermicelli', category: 'snacks', unit: 'g',
    subnames: ['sewai', 'seviyan', 'vermicelli'] },
  { canonical: 'Fox Nuts', category: 'snacks', unit: 'g',
    subnames: ['makhana', 'makhane', 'fox nuts', 'lotus seeds'] },

  // ------------------------------------------------------ dry fruits
  { canonical: 'Almonds', category: 'dryfruit', unit: 'g',
    subnames: ['badam', 'baadam', 'almonds'] },
  { canonical: 'Cashews', category: 'dryfruit', unit: 'g',
    subnames: ['kaju', 'kaaju', 'cashew'] },
  { canonical: 'Raisins', category: 'dryfruit', unit: 'g',
    subnames: ['kishmish', 'kismis', 'raisins', 'munakka'] },
  { canonical: 'Walnuts', category: 'dryfruit', unit: 'g',
    subnames: ['akhrot', 'akhroat', 'walnut'] },
  { canonical: 'Peanuts', category: 'dryfruit', unit: 'kg',
    subnames: ['mungfali', 'moongfali', 'peanut', 'groundnut'] },

  // --------------------------------------------------- condiments
  { canonical: 'Tomato Ketchup', category: 'condiment', unit: 'g',
    subnames: ['sauce', 'tomato sauce', 'ketchup', 'sos'] },
  { canonical: 'Mixed Pickle', category: 'condiment', unit: 'g',
    subnames: ['achar', 'achaar', 'pickle', 'mix achar'] },
  { canonical: 'Mango Pickle', category: 'condiment', unit: 'g',
    subnames: ['aam ka achar', 'aam achar', 'mango pickle'] },
  { canonical: 'Honey', category: 'condiment', unit: 'g',
    subnames: ['shahad', 'shehad', 'honey', 'madhu'] },
  { canonical: 'Vinegar', category: 'condiment', unit: 'ml',
    subnames: ['sirka', 'vinegar'] },

  // ----------------------------------------------------- home care
  { canonical: 'Detergent Powder', category: 'homecare', unit: 'kg',
    subnames: ['surf', 'detergent', 'washing powder', 'kapde dhone ka powder', 'nirma'] },
  { canonical: 'Detergent Bar', category: 'homecare', unit: 'pc',
    subnames: ['sabun tikiya', 'kapde wala sabun', 'detergent bar', 'washing bar'] },
  { canonical: 'Dishwash Bar', brand: 'Vim', category: 'homecare', unit: 'pc',
    subnames: ['vim bar', 'vim', 'bartan wala sabun', 'bartan dhone ka sabun'] },
  { canonical: 'Dishwash Liquid', category: 'homecare', unit: 'ml',
    subnames: ['bartan liquid', 'dishwash', 'vim liquid'] },
  { canonical: 'Floor Cleaner', category: 'homecare', unit: 'ml',
    subnames: ['phenyl', 'lizol', 'floor cleaner', 'pochha wala'] },
  { canonical: 'Toilet Cleaner', category: 'homecare', unit: 'ml',
    subnames: ['harpic', 'toilet cleaner'] },
  { canonical: 'Matchbox', category: 'homecare', unit: 'pc',
    subnames: ['maachis', 'machis', 'matchbox', 'diyasalai'] },
  { canonical: 'Incense Sticks', category: 'homecare', unit: 'pc',
    subnames: ['agarbatti', 'agarbati', 'incense', 'dhoop'] },
  { canonical: 'Candle', category: 'homecare', unit: 'pc',
    subnames: ['mombatti', 'mombati', 'candle'] },

  // ------------------------------------------------- personal care
  { canonical: 'Bath Soap', category: 'personal', unit: 'pc',
    subnames: ['sabun', 'saabun', 'nahane ka sabun', 'soap', 'lifebuoy', 'lux'] },
  { canonical: 'Shampoo', category: 'personal', unit: 'ml',
    subnames: ['shampoo', 'shampu', 'baal dhone wala'] },
  { canonical: 'Coconut Hair Oil', brand: 'Parachute', category: 'personal', unit: 'ml',
    subnames: ['parachute', 'nariyal tel', 'nariyal ka tel', 'baalo ka tel', 'coconut oil'] },
  { canonical: 'Toothpaste', category: 'personal', unit: 'g',
    subnames: ['colgate', 'toothpaste', 'manjan', 'dant manjan', 'paste'] },
  { canonical: 'Toothbrush', category: 'personal', unit: 'pc',
    subnames: ['brush', 'toothbrush', 'dant brush'] },
  { canonical: 'Talcum Powder', category: 'personal', unit: 'g',
    subnames: ['powder', 'talcum', 'pawder'] },
  { canonical: 'Hair Dye', category: 'personal', unit: 'g',
    subnames: ['mehendi', 'hair dye', 'baal kala karne wala'] },
  { canonical: 'Sanitary Pads', category: 'personal', unit: 'pc',
    subnames: ['pads', 'whisper', 'stayfree', 'napkin'] },

  /* ===================================================================
     From a South Indian monthly grocery list (SimpleIndianRecipes.com).
     Everything below was absent from the block above.

     The list is worth having because the corpus started North-Indian and
     a resolver that only knows "chawal" is useless in Chennai. Where a
     product has both a Hindi and a Tamil name in common use, both are
     subnames: a shop in Jaipur and a shop in Coimbatore should each be
     understood by their own customers without anybody configuring a
     language.
     =================================================================== */

  // ---------------------------------------------------------- rice
  { canonical: 'Idli Rice', category: 'rice', unit: 'kg',
    subnames: ['idli rice', 'idli arisi', 'idli chawal', 'puzhungal arisi'] },
  { canonical: 'Boiled Rice', category: 'rice', unit: 'kg',
    subnames: ['boiled rice', 'puzhungal arisi', 'ukda chawal', 'sela chawal'] },
  { canonical: 'Raw Rice', category: 'rice', unit: 'kg',
    subnames: ['raw rice', 'pacharisi', 'kacha chawal', 'arisi'] },
  { canonical: 'Brown Rice', category: 'rice', unit: 'kg',
    subnames: ['brown rice', 'bhura chawal', 'red rice', 'sivappu arisi'] },

  // --------------------------------------------------------- flour
  { canonical: 'Ragi Flour', category: 'flour', unit: 'kg',
    subnames: ['ragi', 'ragi atta', 'ragi maavu', 'nachni', 'finger millet flour'] },
  { canonical: 'Rice Flour', category: 'flour', unit: 'kg',
    subnames: ['rice flour', 'chawal ka atta', 'arisi maavu', 'chaval atta'] },
  { canonical: 'Broken Wheat', category: 'flour', unit: 'kg',
    subnames: ['dalia', 'daliya', 'lapsi', 'samba godhumai', 'broken wheat', 'godhuma rava'] },
  { canonical: 'Millet Grain', category: 'flour', unit: 'kg',
    subnames: ['millet', 'bajra', 'samai', 'thinai', 'kambu', 'varagu', 'kuthiraivali', 'siridhanya'] },

  // -------------------------------------------------------- pulses
  { canonical: 'Whole Green Gram', category: 'pulses', unit: 'kg',
    subnames: ['sabut moong', 'moong sabut', 'green gram', 'pachai payaru', 'whole moong'] },
  { canonical: 'Whole Masoor', category: 'pulses', unit: 'kg',
    subnames: ['sabut masoor', 'whole masoor', 'brown lentil'] },
  { canonical: 'Whole Urad', category: 'pulses', unit: 'kg',
    subnames: ['sabut urad', 'kaali urad', 'whole urad', 'ulundhu'] },
  { canonical: 'Dried Green Peas', category: 'pulses', unit: 'kg',
    subnames: ['sukhe matar', 'safed matar', 'dried peas', 'pattani'] },
  { canonical: 'Double Beans', category: 'pulses', unit: 'kg',
    subnames: ['double beans', 'lima beans', 'mochai'] },

  // ----------------------------------------------------------- oil
  { canonical: 'Sesame Oil', category: 'oil', unit: 'l',
    subnames: ['til ka tel', 'gingelly oil', 'nallennai', 'sesame oil', 'til tel'] },
  { canonical: 'Cooking Coconut Oil', category: 'oil', unit: 'l',
    subnames: ['nariyal tel', 'thengai ennai', 'coconut oil', 'khane wala nariyal tel'] },
  { canonical: 'Olive Oil', category: 'oil', unit: 'l',
    subnames: ['olive oil', 'jaitun ka tel'] },

  // ------------------------------------------------------- staples
  { canonical: 'Palm Jaggery', category: 'staple', unit: 'kg',
    subnames: ['palm jaggery', 'naatu chakkarai', 'karupatti', 'taad gud'] },
  { canonical: 'Tamarind', category: 'staple', unit: 'kg',
    subnames: ['imli', 'puli', 'tamarind', 'imli ka gooda'] },

  // -------------------------------------------------------- spices
  { canonical: 'Dry Red Chillies', category: 'spice', unit: 'g',
    subnames: ['sukhi lal mirch', 'sabut mirch', 'dry red chilli', 'vathal milagai', 'khadi mirch'] },
  { canonical: 'Fennel Seeds', category: 'spice', unit: 'g',
    subnames: ['saunf', 'sonf', 'fennel', 'perunjeeragam'] },
  { canonical: 'Poppy Seeds', category: 'spice', unit: 'g',
    subnames: ['khus khus', 'khuskhus', 'poppy seeds', 'kasa kasa'] },
  { canonical: 'Sesame Seeds', category: 'spice', unit: 'g',
    subnames: ['til', 'safed til', 'sesame seeds', 'ellu'] },
  { canonical: 'Dry Ginger', category: 'spice', unit: 'g',
    subnames: ['sonth', 'saunth', 'sukku', 'dry ginger'] },
  { canonical: 'Star Anise', category: 'spice', unit: 'g',
    subnames: ['chakra phool', 'star anise', 'anasi poo'] },
  { canonical: 'Ginger Garlic Paste', category: 'spice', unit: 'g',
    subnames: ['adrak lehsun paste', 'ginger garlic paste', 'adrak lasan', 'inji poondu'] },
  { canonical: 'Cumin Powder', category: 'spice', unit: 'g',
    subnames: ['jeera powder', 'zeera powder', 'cumin powder'] },
  { canonical: 'Black Pepper Powder', category: 'spice', unit: 'g',
    subnames: ['kali mirch powder', 'pepper powder', 'milagu podi'] },
  { canonical: 'Idli Podi', category: 'spice', unit: 'g',
    subnames: ['idli podi', 'milagai podi', 'gunpowder', 'chutney podi'] },
  { canonical: 'Rasam Powder', category: 'spice', unit: 'g',
    subnames: ['rasam powder', 'rasam podi'] },
  { canonical: 'Chana Masala', category: 'spice', unit: 'g',
    subnames: ['chana masala', 'chole masala', 'chhole masala'] },
  { canonical: 'Pav Bhaji Masala', category: 'spice', unit: 'g',
    subnames: ['pav bhaji masala', 'pao bhaji masala'] },
  { canonical: 'Chicken Masala', category: 'spice', unit: 'g',
    subnames: ['chicken masala', 'meat masala', 'non veg masala'] },

  // ---------------------------------------------------- condiments
  { canonical: 'Soy Sauce', category: 'condiment', unit: 'ml',
    subnames: ['soy sauce', 'soya sauce', 'soyabean sauce'] },
  { canonical: 'Chilli Sauce', category: 'condiment', unit: 'ml',
    subnames: ['chilli sauce', 'red sauce', 'schezwan sauce'] },
  { canonical: 'Mayonnaise', category: 'condiment', unit: 'g',
    subnames: ['mayonnaise', 'mayo', 'mayonaise'] },
  { canonical: 'Mixed Fruit Jam', category: 'condiment', unit: 'g',
    subnames: ['jam', 'jaam', 'mixed fruit jam', 'kissan jam'] },
  { canonical: 'Chocolate Syrup', category: 'condiment', unit: 'ml',
    subnames: ['chocolate syrup', 'choco syrup', 'hershey syrup'] },

  // --------------------------------------------------------- dairy
  { canonical: 'Cheese Spread', category: 'dairy', unit: 'g',
    subnames: ['cheese spread', 'cheese', 'britannia cheese spread'] },
  { canonical: 'Cheese Block', category: 'dairy', unit: 'g',
    subnames: ['cheese block', 'cheese cube', 'pizza cheese', 'mozzarella'] },
  { canonical: 'Fresh Cream', category: 'dairy', unit: 'ml',
    subnames: ['fresh cream', 'malai', 'cream', 'amul cream'] },
  { canonical: 'Flavoured Yogurt', category: 'dairy', unit: 'g',
    subnames: ['yogurt', 'flavoured dahi', 'fruit yogurt', 'misti dahi'] },

  // ------------------------------------------------------- bakery
  { canonical: 'Pav Buns', category: 'bakery', unit: 'pc',
    subnames: ['pav', 'paav', 'buns', 'ladi pav', 'burger bun'] },
  { canonical: 'Pizza Base', category: 'bakery', unit: 'pc',
    subnames: ['pizza base', 'pizza bread'] },

  // -------------------------------------------------------- baking
  { canonical: 'Dates', category: 'dryfruit', unit: 'g',
    subnames: ['khajoor', 'khajur', 'dates', 'pericham pazham'] },
  { canonical: 'Dry Yeast', category: 'baking', unit: 'g',
    subnames: ['yeast', 'khameer', 'dry yeast'] },
  { canonical: 'Baking Soda', category: 'baking', unit: 'g',
    subnames: ['baking soda', 'meetha soda', 'cooking soda', 'khane wala soda'] },
  { canonical: 'Baking Powder', category: 'baking', unit: 'g',
    subnames: ['baking powder'] },
  { canonical: 'Cocoa Powder', category: 'baking', unit: 'g',
    subnames: ['cocoa powder', 'coco powder', 'chocolate powder'] },
  { canonical: 'Vanilla Extract', category: 'baking', unit: 'ml',
    subnames: ['vanilla essence', 'vanilla extract', 'essence'] },

  // -------------------------------------------------------- snacks
  { canonical: 'Pasta', category: 'snacks', unit: 'g',
    subnames: ['pasta', 'macaroni', 'penne'] },
  { canonical: 'Plain Noodles', category: 'snacks', unit: 'g',
    subnames: ['noodles', 'hakka noodles', 'chowmein', 'chaumin'] },
  { canonical: 'Rice Sevai', category: 'snacks', unit: 'g',
    subnames: ['rice sevai', 'idiyappam', 'santhakai', 'instant sevai'] },
  { canonical: 'Breakfast Cereal', category: 'snacks', unit: 'g',
    subnames: ['cornflakes', 'corn flakes', 'cereal', 'kelloggs'] },
  { canonical: 'Popcorn', category: 'snacks', unit: 'g',
    subnames: ['popcorn', 'pop corn', 'makai popcorn'] },

  // ------------------------------------------------------ homecare
  { canonical: 'Bleach', category: 'homecare', unit: 'ml',
    subnames: ['bleach', 'safed karne wala', 'ala', 'whitener'] },
  { canonical: 'Fabric Softener', category: 'homecare', unit: 'ml',
    subnames: ['fabric softener', 'comfort', 'kapde softener'] },
  { canonical: 'Hand Wash Liquid', category: 'homecare', unit: 'ml',
    subnames: ['hand wash', 'handwash', 'liquid soap', 'dettol handwash'] },
  { canonical: 'Glass Cleaner', category: 'homecare', unit: 'ml',
    subnames: ['glass cleaner', 'colin', 'sheesha cleaner'] },
  { canonical: 'Room Freshener', category: 'homecare', unit: 'ml',
    subnames: ['room freshener', 'air freshener', 'room spray', 'odonil'] },
  { canonical: 'Garbage Bags', category: 'homecare', unit: 'pc',
    subnames: ['garbage bag', 'dustbin bag', 'kachra bag', 'trash bag'] },
  { canonical: 'Mosquito Repellent', category: 'homecare', unit: 'pc',
    subnames: ['machar bhagane wala', 'all out', 'good knight', 'mosquito coil', 'kachua chaap'] },
  { canonical: 'Broom', category: 'homecare', unit: 'pc',
    subnames: ['jhadu', 'jhaadu', 'broom', 'supdi'] },
  { canonical: 'Phenyl', category: 'homecare', unit: 'ml',
    subnames: ['phenyl', 'fineil', 'pochha wala liquid'] },

  // ------------------------------------------------------ personal
  { canonical: 'Deodorant', category: 'personal', unit: 'ml',
    subnames: ['deo', 'deodorant', 'body spray', 'spray'] },
  { canonical: 'Hair Conditioner', category: 'personal', unit: 'ml',
    subnames: ['conditioner', 'hair conditioner'] },
  { canonical: 'Body Lotion', category: 'personal', unit: 'ml',
    subnames: ['body lotion', 'moisturiser', 'lotion', 'cold cream'] },
  { canonical: 'Sunscreen Lotion', category: 'personal', unit: 'ml',
    subnames: ['sunscreen', 'sun cream', 'sunblock'] },
  { canonical: 'Shaving Cream', category: 'personal', unit: 'g',
    subnames: ['shaving cream', 'shave cream', 'daadhi wala cream'] },
  { canonical: 'Razor', category: 'personal', unit: 'pc',
    subnames: ['razor', 'blade', 'shaving razor', 'gillette'] },
  { canonical: 'Hand Sanitizer', category: 'personal', unit: 'ml',
    subnames: ['sanitizer', 'hand sanitizer', 'sanitiser'] },
  { canonical: 'Antiseptic Liquid', category: 'personal', unit: 'ml',
    subnames: ['dettol', 'savlon', 'antiseptic', 'antiseptic liquid'] },
  { canonical: 'Toilet Paper', category: 'personal', unit: 'pc',
    subnames: ['toilet paper', 'tissue roll', 'toilet roll'] },
  { canonical: 'Kitchen Towel Roll', category: 'personal', unit: 'pc',
    subnames: ['kitchen roll', 'kitchen towel', 'paper towel'] },
  { canonical: 'Facial Tissue', category: 'personal', unit: 'pc',
    subnames: ['tissue', 'tissue paper', 'napkin', 'face tissue'] },
  { canonical: 'Cotton Buds', category: 'personal', unit: 'pc',
    subnames: ['ear buds', 'cotton buds', 'kaan saaf karne wala'] },
  { canonical: 'Talc Free Face Powder', category: 'personal', unit: 'g',
    subnames: ['face powder', 'compact', 'powder'] },

  // ----------------------------------------------------- disposable
  { canonical: 'Paper Plates', category: 'disposable', unit: 'pc',
    subnames: ['paper plate', 'dona pattal', 'disposable plate'] },
  { canonical: 'Paper Cups', category: 'disposable', unit: 'pc',
    subnames: ['paper cup', 'disposable glass', 'chai ka cup'] },
  { canonical: 'Disposable Spoons', category: 'disposable', unit: 'pc',
    subnames: ['plastic spoon', 'disposable spoon', 'chammach'] },
];

/** Flattened form the trigram index searches over. */
export function kbSearchText(e: KbEntry): string {
  return [e.canonical, e.brand ?? '', ...e.subnames].join(' ').toLowerCase();
}
