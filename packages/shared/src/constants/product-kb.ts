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

const BASE_KB: KbEntry[] = [
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

  /* ===================================================================
     Fresh produce, pooja and household, from a South Indian monthly
     checklist. Vegetables were missing entirely, which is a real hole: a
     kirana sells onions and tomatoes every single day, and "pyaaz" or
     "vengayam" is among the most-said words at any counter.
     =================================================================== */

  // ------------------------------------------------------- vegetables
  { canonical: 'Tomato', category: 'vegetable', unit: 'kg',
    subnames: ['tamatar', 'tamaatar', 'tomato', 'thakkali'] },
  { canonical: 'Onion', category: 'vegetable', unit: 'kg',
    subnames: ['pyaaz', 'pyaz', 'kanda', 'onion', 'vengayam'] },
  { canonical: 'Potato', category: 'vegetable', unit: 'kg',
    subnames: ['aloo', 'alu', 'batata', 'potato', 'urulaikizhangu'] },
  { canonical: 'Garlic', category: 'vegetable', unit: 'g',
    subnames: ['lehsun', 'lahsun', 'garlic', 'poondu'] },
  { canonical: 'Ginger', category: 'vegetable', unit: 'g',
    subnames: ['adrak', 'ginger', 'inji'] },
  { canonical: 'Green Chilli', category: 'vegetable', unit: 'g',
    subnames: ['hari mirch', 'hari mirchi', 'green chilli', 'pachai milagai'] },
  { canonical: 'Carrot', category: 'vegetable', unit: 'kg',
    subnames: ['gajar', 'carrot', 'gaajar'] },
  { canonical: 'Beetroot', category: 'vegetable', unit: 'kg',
    subnames: ['chukandar', 'beetroot', 'beet'] },
  { canonical: 'Cauliflower', category: 'vegetable', unit: 'kg',
    subnames: ['gobhi', 'gobi', 'phool gobhi', 'cauliflower'] },
  { canonical: 'Cabbage', category: 'vegetable', unit: 'kg',
    subnames: ['patta gobhi', 'band gobhi', 'cabbage', 'muttaikose'] },
  { canonical: 'Spinach', category: 'vegetable', unit: 'kg',
    subnames: ['palak', 'spinach', 'keerai'] },
  { canonical: 'Beans', category: 'vegetable', unit: 'kg',
    subnames: ['beans', 'french beans', 'fali', 'avarakkai'] },
  { canonical: 'Pumpkin', category: 'vegetable', unit: 'kg',
    subnames: ['kaddu', 'pumpkin', 'poosanikai', 'sitaphal'] },
  { canonical: 'Lemon', category: 'vegetable', unit: 'pc',
    subnames: ['nimbu', 'neembu', 'lemon', 'lime', 'elumichai'] },
  { canonical: 'Coconut', category: 'vegetable', unit: 'pc',
    subnames: ['nariyal', 'naariyal', 'coconut', 'thengai'] },
  { canonical: 'Curry Leaves', category: 'vegetable', unit: 'g',
    subnames: ['kadi patta', 'curry patta', 'curry leaves', 'karuveppilai'] },
  { canonical: 'Coriander Leaves', category: 'vegetable', unit: 'g',
    subnames: ['hara dhaniya', 'dhaniya patta', 'coriander leaves', 'kothamalli'] },
  { canonical: 'Mint Leaves', category: 'vegetable', unit: 'g',
    subnames: ['pudina', 'mint', 'pudhina'] },
  { canonical: 'Banana', category: 'vegetable', unit: 'dz',
    subnames: ['kela', 'kele', 'banana', 'vazhaipazham'] },
  { canonical: 'Apple', category: 'vegetable', unit: 'kg',
    subnames: ['seb', 'apple', 'aapil'] },

  // ------------------------------------------------------ grain gaps
  { canonical: 'Oats', category: 'flour', unit: 'kg',
    subnames: ['oats', 'oat', 'jai'] },
  { canonical: 'Idli Rava', category: 'flour', unit: 'kg',
    subnames: ['idli rava', 'idli rawa', 'rice rava', 'arisi rava'] },
  { canonical: 'Bombay Rava', category: 'flour', unit: 'kg',
    subnames: ['bombay rava', 'chiroti rava', 'fine rava', 'barik suji'] },
  { canonical: 'Kuttu Atta', category: 'flour', unit: 'kg',
    subnames: ['kuttu atta', 'kuttu ka atta', 'buckwheat flour', 'vrat ka atta'] },
  { canonical: 'Rajgira Atta', category: 'flour', unit: 'kg',
    subnames: ['rajgira', 'ramdana', 'amaranth flour', 'vrat ka atta'] },
  { canonical: 'Quinoa', category: 'flour', unit: 'kg',
    subnames: ['quinoa', 'kinva'] },

  // ------------------------------------------------------ pulse gaps
  { canonical: 'Fried Gram Dal', category: 'pulses', unit: 'kg',
    subnames: ['pottukadalai', 'fried gram', 'daliya dal', 'roasted chana dal', 'putani'] },
  { canonical: 'Horse Gram', category: 'pulses', unit: 'kg',
    subnames: ['kulthi', 'horsegram', 'kollu', 'kulith'] },
  { canonical: 'Flax Seeds', category: 'pulses', unit: 'g',
    subnames: ['alsi', 'flax seeds', 'javas', 'ali vidai'] },
  { canonical: 'Chia Seeds', category: 'pulses', unit: 'g',
    subnames: ['chia seeds', 'chia'] },
  { canonical: 'Pumpkin Seeds', category: 'pulses', unit: 'g',
    subnames: ['pumpkin seeds', 'kaddu ke beej'] },

  // ------------------------------------------------------ spice gaps
  { canonical: 'Amchoor Powder', category: 'spice', unit: 'g',
    subnames: ['amchoor', 'amchur', 'aamchur', 'dry mango powder'] },
  { canonical: 'Biryani Masala', category: 'spice', unit: 'g',
    subnames: ['biryani masala', 'biriyani masala', 'biryani powder'] },
  { canonical: 'Garlic Powder', category: 'spice', unit: 'g',
    subnames: ['garlic powder', 'lehsun powder', 'poondu podi'] },
  { canonical: 'Vathakuzhambu Powder', category: 'spice', unit: 'g',
    subnames: ['vathakuzhambu powder', 'vatha kuzhambu podi', 'kuzhambu podi'] },
  { canonical: 'Whole Garam Masala', category: 'spice', unit: 'g',
    subnames: ['sabut garam masala', 'khada masala', 'whole garam masala', 'biryani spices'] },
  { canonical: 'Saffron', category: 'spice', unit: 'g',
    subnames: ['kesar', 'keshar', 'saffron', 'zafran'] },
  { canonical: 'Coriander Seeds', category: 'spice', unit: 'g',
    subnames: ['sabut dhaniya', 'dhania seeds', 'coriander seeds', 'kothamalli vidai'] },

  // ---------------------------------------------------- other food
  { canonical: 'Coconut Milk', category: 'dairy', unit: 'ml',
    subnames: ['coconut milk', 'nariyal ka doodh', 'thengai paal'] },
  { canonical: 'Idli Dosa Batter', category: 'dairy', unit: 'kg',
    subnames: ['idli batter', 'dosa batter', 'maavu', 'idli dosa batter'] },
  { canonical: 'Macaroni', category: 'snacks', unit: 'g',
    subnames: ['macaroni', 'makroni'] },
  { canonical: 'Spaghetti', category: 'snacks', unit: 'g',
    subnames: ['spaghetti', 'spagetti'] },
  { canonical: 'Pizza Sauce', category: 'condiment', unit: 'g',
    subnames: ['pizza sauce', 'pasta sauce'] },
  { canonical: 'Fruit Salt', category: 'condiment', unit: 'g',
    subnames: ['eno', 'fruit salt', 'ino'] },
  { canonical: 'Namkeen Bhujia', category: 'snacks', unit: 'g',
    subnames: ['bhujia', 'haldiram', 'namkeen', 'sev bhujia'] },
  { canonical: 'Rock Candy', category: 'staple', unit: 'g',
    subnames: ['mishri', 'kalkandu', 'rock candy', 'dhaga mishri'] },

  // -------------------------------------------------------- pooja
  { canonical: 'Camphor', category: 'pooja', unit: 'g',
    subnames: ['kapoor', 'kapur', 'camphor', 'karpooram'] },
  { canonical: 'Lamp Oil', category: 'pooja', unit: 'l',
    subnames: ['deepam oil', 'diya ka tel', 'lamp oil', 'deepa oil'] },
  { canonical: 'Cotton Wicks', category: 'pooja', unit: 'pc',
    subnames: ['batti', 'rui batti', 'cotton wick', 'thiri'] },
  { canonical: 'Dhoop Sticks', category: 'pooja', unit: 'pc',
    subnames: ['dhoop', 'sambrani', 'dhoop batti'] },
  { canonical: 'Kumkum', category: 'pooja', unit: 'g',
    subnames: ['kumkum', 'kunkumam', 'sindoor', 'roli'] },

  // ---------------------------------------------------- household
  { canonical: 'Light Bulb', category: 'homecare', unit: 'pc',
    subnames: ['bulb', 'balb', 'light bulb', 'led bulb'] },
  { canonical: 'Dry Cell Battery', category: 'homecare', unit: 'pc',
    subnames: ['battery', 'cell', 'pencil cell', 'eveready'] },
  { canonical: 'Scrub Sponge', category: 'homecare', unit: 'pc',
    subnames: ['scrubber', 'sponge', 'jhaawa', 'bartan scrub'] },
  { canonical: 'Kitchen Cleaner', category: 'homecare', unit: 'ml',
    subnames: ['kitchen cleaner', 'platform cleaner', 'sink cleaner'] },
  { canonical: 'Naphthalene Balls', category: 'homecare', unit: 'g',
    subnames: ['naphthalene balls', 'kapoor goli', 'moth balls'] },
  { canonical: 'Rubber Bands', category: 'homecare', unit: 'g',
    subnames: ['rubber band', 'elastic', 'rubberband'] },

  // ----------------------------------------------------- personal
  { canonical: 'Baby Diapers', category: 'personal', unit: 'pc',
    subnames: ['diaper', 'daiper', 'pampers', 'nappy', 'baby diaper'] },
  { canonical: 'Kajal', category: 'personal', unit: 'g',
    subnames: ['kajal', 'kaajal', 'kohl'] },
  { canonical: 'Hair Gel', category: 'personal', unit: 'g',
    subnames: ['hair gel', 'gel', 'baal gel'] },
  { canonical: 'Pain Relief Balm', category: 'personal', unit: 'g',
    subnames: ['balm', 'baam', 'zandu balm', 'vicks', 'amrutanjan', 'moov'] },
  { canonical: 'Pet Food', category: 'personal', unit: 'kg',
    subnames: ['pet food', 'dog food', 'cat food', 'kutte ka khana'] },
];


/* ---------------------------------------------------------------------
   THE BRAND LEXICON.

   At a counter, people ask for brands far more often than for products.
   Nobody says "toothpaste"; they say "colgate". Nobody says "detergent";
   they say "surf" or "nirma" or "ghadi". A brand IS a subname, and usually
   the primary one, so the corpus has to carry them.

   Written as sector -> brands and expanded below rather than typed out as
   two hundred literals, so adding a brand is one word in a list.

   Each generated entry carries the brand AND the generic names for its
   category, which is what keeps alias generation sensible: shown a Colgate
   product it proposes "colgate, toothpaste, manjan" rather than proposing
   a rival brand it happened to see nearby.

   The source chart sorted these by Indian versus multinational ownership.
   That distinction is not carried here: it tells you nothing about what a
   customer will say, which is the only question this corpus answers.
   --------------------------------------------------------------------- */

interface BrandGroup {
  product: string;
  category: string;
  unit: string;
  /** what people call the category regardless of brand */
  generic: string[];
  brands: string[];
}

const BRAND_GROUPS: BrandGroup[] = [
  { product: 'Toothpaste', category: 'personal', unit: 'g',
    generic: ['toothpaste', 'manjan', 'dant manjan', 'paste'],
    brands: ['Colgate', 'Pepsodent', 'Close Up', 'Sensodyne', 'Dabur Red', 'Dant Kanti', 'Meswak', 'Babool', 'Vicco'] },
  { product: 'Bath Soap', category: 'personal', unit: 'pc',
    generic: ['sabun', 'saabun', 'nahane ka sabun', 'soap'],
    brands: ['Lifebuoy', 'Lux', 'Dove', 'Pears', 'Santoor', 'Medimix', 'Margo', 'Cinthol', 'Mysore Sandal', 'Hamam', 'Rexona', 'Liril', 'Dettol'] },
  { product: 'Detergent Powder', category: 'homecare', unit: 'kg',
    generic: ['surf', 'detergent', 'washing powder', 'kapde dhone ka powder'],
    brands: ['Surf Excel', 'Rin', 'Tide', 'Ariel', 'Wheel', 'Nirma', 'Ghadi', 'Fena', 'Ujala'] },
  { product: 'Detergent Bar', category: 'homecare', unit: 'pc',
    generic: ['sabun tikiya', 'kapde wala sabun', 'washing bar'],
    brands: ['Rin', 'Wheel', 'Nirma', 'Ghadi'] },
  { product: 'Shampoo', category: 'personal', unit: 'ml',
    generic: ['shampoo', 'shampu', 'baal dhone wala'],
    brands: ['Clinic Plus', 'Pantene', 'Head and Shoulders', 'Sunsilk', 'Dove', 'Nyle', 'Chik', 'Himalaya', 'Vatika', 'Patanjali'] },
  { product: 'Face Wash', category: 'personal', unit: 'g',
    generic: ['face wash', 'muh dhone wala', 'facewash'],
    brands: ['Ponds', 'Garnier', 'Himalaya', 'Everyuth', 'Nomarks', 'Clean and Clear'] },
  { product: 'Talcum Powder', category: 'personal', unit: 'g',
    generic: ['powder', 'talcum', 'pawder'],
    brands: ['Ponds', 'Nivea', 'Dermi Cool', 'Cinthol', 'Navratna', 'Gokul Santol', 'Spinz'] },
  { product: 'Body Lotion', category: 'personal', unit: 'ml',
    generic: ['body lotion', 'moisturiser', 'lotion', 'cold cream'],
    brands: ['Nivea', 'Vaseline', 'Dove', 'Santoor', 'Himalaya', 'Boroplus'] },
  { product: 'Hand Wash Liquid', category: 'homecare', unit: 'ml',
    generic: ['hand wash', 'handwash', 'liquid soap'],
    brands: ['Lifebuoy', 'Dettol', 'Palmolive', 'Godrej', 'Santoor'] },
  { product: 'Razor', category: 'personal', unit: 'pc',
    generic: ['razor', 'blade', 'shaving razor'],
    brands: ['Gillette', 'Super Max', 'Park Avenue', 'Laser Ultra'] },
  { product: 'Shaving Cream', category: 'personal', unit: 'g',
    generic: ['shaving cream', 'shave cream'],
    brands: ['Gillette', 'Old Spice', 'Vi John', 'Godrej', 'Park Avenue', 'Nivea'] },
  { product: 'Hair Colour', category: 'personal', unit: 'g',
    generic: ['hair colour', 'baal kala karne wala', 'hair dye', 'mehendi'],
    brands: ['Godrej', 'Loreal', 'Garnier', 'Indica', 'Color Mate', 'Neha'] },
  { product: 'Pain Relief Balm', category: 'personal', unit: 'g',
    generic: ['balm', 'baam', 'dard ka balm'],
    brands: ['Vicks', 'Zandu Balm', 'Amrutanjan', 'Tiger Balm', 'Moov', 'Iodex', 'Volini'] },
  { product: 'Baby Diapers', category: 'personal', unit: 'pc',
    generic: ['diaper', 'nappy', 'daiper'],
    brands: ['Pampers', 'Huggies', 'Mamy Poko', 'Little Angel'] },
  { product: 'Mosquito Repellent', category: 'homecare', unit: 'pc',
    generic: ['machar bhagane wala', 'mosquito coil', 'machhar'],
    brands: ['All Out', 'Good Knight', 'Mortein', 'Maxo'] },
  { product: 'Malted Health Drink', category: 'beverage', unit: 'g',
    generic: ['health drink', 'powder doodh wala'],
    brands: ['Boost', 'Complan', 'Nutramul', 'Ojasvita'] },
  { product: 'Chewing Gum', category: 'snacks', unit: 'g',
    generic: ['chewing gum', 'chingam', 'gum'],
    brands: ['Orbit', 'Center Fresh', 'Happydent', 'Center Fruit', 'Double Mint', 'Chingles'] },
  { product: 'Antacid Powder', category: 'condiment', unit: 'g',
    generic: ['gas ki dawa', 'acidity powder', 'antacid'],
    brands: ['Eno', 'Gas O Fast', 'Pudin Hara'] },
  { product: 'Tomato Ketchup', category: 'condiment', unit: 'g',
    generic: ['sauce', 'tomato sauce', 'ketchup', 'sos'],
    brands: ['Kissan', 'Maggi', 'Del Monte', 'Nilons', 'Topz'] },
  { product: 'Instant Noodles', category: 'snacks', unit: 'g',
    generic: ['noodles', 'nudals'],
    brands: ['Yippee', 'Top Ramen', 'Knorr', 'Chings', 'Wai Wai'] },
  { product: 'Ice Cream', category: 'dairy', unit: 'ml',
    generic: ['ice cream', 'aiskrim', 'kulfi'],
    brands: ['Amul', 'Kwality Walls', 'Havmor', 'Vadilal'] },
  { product: 'Soft Drink', category: 'beverage', unit: 'ml',
    generic: ['cold drink', 'thanda', 'soft drink'],
    brands: ['Coca Cola', 'Pepsi', 'Thums Up', 'Sprite', 'Limca', 'Fanta'] },
  { product: 'Packaged Water', category: 'beverage', unit: 'l',
    generic: ['paani ki bottle', 'water bottle', 'mineral water'],
    brands: ['Bisleri', 'Aquafina', 'Kinley', 'Bailley'] },
  { product: 'Mango Drink', category: 'beverage', unit: 'ml',
    generic: ['aam ka juice', 'mango drink'],
    brands: ['Maaza', 'Slice', 'Frooti'] },
  { product: 'Fruit Juice', category: 'beverage', unit: 'ml',
    generic: ['juice', 'jus', 'fruit juice'],
    brands: ['Real', 'Tropicana', 'B Natural'] },
  { product: 'Chocolate', category: 'snacks', unit: 'g',
    generic: ['chocolate', 'chaklet', 'chocolet'],
    brands: ['Cadbury', 'Dairy Milk', 'Nestle', 'Munch', 'Kitkat', 'Amul'] },
  { product: 'Potato Chips', category: 'snacks', unit: 'g',
    generic: ['chips', 'wafers'],
    brands: ['Lays', 'Bingo', 'Kurkure', 'Balaji'] },
  { product: 'Biscuits', category: 'snacks', unit: 'g',
    generic: ['biscuit', 'biskut', 'biscut'],
    brands: ['Parle', 'Britannia', 'Sunfeast', 'Good Day', 'Priyagold', 'Anmol'] },
  { product: 'Namkeen Mixture', category: 'snacks', unit: 'g',
    generic: ['namkeen', 'namkin', 'mixture', 'sev'],
    brands: ['Haldiram', 'Balaji', 'Bikano', 'Gopal'] },
  { product: 'Tea Leaves', category: 'beverage', unit: 'g',
    generic: ['chai patti', 'chai', 'patti'],
    brands: ['Brooke Bond', 'Taj Mahal', 'Wagh Bakri', 'Society', '3 Roses'] },
  { product: 'Dishwash Bar', category: 'homecare', unit: 'pc',
    generic: ['bartan wala sabun', 'bartan dhone ka sabun'],
    brands: ['Vim', 'Exo', 'Pril'] },
  { product: 'Floor Cleaner', category: 'homecare', unit: 'ml',
    generic: ['phenyl', 'floor cleaner', 'pochha wala'],
    brands: ['Lizol', 'Domex', 'Mr Muscle'] },
  { product: 'Toilet Cleaner', category: 'homecare', unit: 'ml',
    generic: ['toilet cleaner', 'bathroom cleaner'],
    brands: ['Harpic', 'Domex', 'Sanifresh'] },
  { product: 'Room Freshener', category: 'homecare', unit: 'ml',
    generic: ['room freshener', 'air freshener', 'room spray'],
    brands: ['Odonil', 'Ambi Pur', 'Godrej Aer'] },
  { product: 'Incense Sticks', category: 'pooja', unit: 'pc',
    generic: ['agarbatti', 'agarbati', 'incense'],
    brands: ['Cycle', 'Mangaldeep', 'Zed Black'] },
  { product: 'Dry Cell Battery', category: 'homecare', unit: 'pc',
    generic: ['battery', 'cell', 'pencil cell'],
    brands: ['Eveready', 'Duracell', 'Nippo', 'Panasonic'] },
];

/**
 * One entry per (product, brand), carrying the brand plus its category's
 * generic names. Brand first: it is what the customer says first.
 */
function expandBrands(): KbEntry[] {
  // (canonical, brand) is a unique key in the database, and a few brands are
  // already written by hand above with better subnames than a generic
  // expansion would give them. Hand-written wins.
  const already = new Set(BASE_KB.map((e) => `${e.canonical}|${e.brand ?? ''}`));

  return BRAND_GROUPS.flatMap((g) =>
    g.brands
      .filter((brand) => !already.has(`${g.product}|${brand}`))
      .map((brand) => ({
        canonical: g.product,
        brand,
        category: g.category,
        unit: g.unit,
        subnames: [...new Set([brand.toLowerCase(), ...g.generic])],
      })),
  );
}

/**
 * The corpus the retriever indexes: hand-written products first, then every
 * brand expanded against its category.
 */
export const PRODUCT_KB: KbEntry[] = [...BASE_KB, ...expandBrands()];

/** Flattened form the trigram index searches over. */
export function kbSearchText(e: KbEntry): string {
  return [e.canonical, e.brand ?? '', ...e.subnames].join(' ').toLowerCase();
}
