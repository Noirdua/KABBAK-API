"use strict";

function city(id, name, latitude, longitude, aliases = []) {
  return { id, name, latitude, longitude, aliases };
}

function region(id, name, latitude, longitude, cities = [], aliases = []) {
  return { id, name, latitude, longitude, aliases, cities };
}

function country(id, name, latitude, longitude, extras = {}) {
  return {
    id,
    name,
    latitude,
    longitude,
    aliases: extras.aliases || [],
    regions: extras.regions || [],
    cities: extras.cities || []
  };
}

const US_REGIONS = [
  region("al", "Alabama", 32.3777, -86.3006, [
    city("birmingham", "Birmingham", 33.5186, -86.8104),
    city("montgomery", "Montgomery", 32.3668, -86.3),
    city("huntsville", "Huntsville", 34.7304, -86.5861),
    city("mobile", "Mobile", 30.6954, -88.0399)
  ], ["AL"]),
  region("ak", "Alaska", 61.2181, -149.9003, [
    city("anchorage", "Anchorage", 61.2181, -149.9003),
    city("fairbanks", "Fairbanks", 64.8378, -147.7164),
    city("juneau", "Juneau", 58.3019, -134.4197)
  ], ["AK"]),
  region("az", "Arizona", 33.4484, -112.074, [
    city("phoenix", "Phoenix", 33.4484, -112.074),
    city("tucson", "Tucson", 32.2226, -110.9747),
    city("mesa", "Mesa", 33.4152, -111.8315),
    city("flagstaff", "Flagstaff", 35.1983, -111.6513),
    city("scottsdale", "Scottsdale", 33.4942, -111.9261)
  ], ["AZ"]),
  region("ar", "Arkansas", 34.7465, -92.2896, [
    city("little-rock", "Little Rock", 34.7465, -92.2896),
    city("fayetteville", "Fayetteville", 36.0822, -94.1719)
  ], ["AR"]),
  region("ca", "California", 36.7783, -119.4179, [
    city("los-angeles", "Los Angeles", 34.0522, -118.2437, ["LA", "L.A."]),
    city("san-francisco", "San Francisco", 37.7749, -122.4194, ["SF"]),
    city("san-diego", "San Diego", 32.7157, -117.1611),
    city("san-jose", "San Jose", 37.3382, -121.8863),
    city("sacramento", "Sacramento", 38.5816, -121.4944),
    city("oakland", "Oakland", 37.8044, -122.2712),
    city("fresno", "Fresno", 36.7378, -119.7871),
    city("long-beach", "Long Beach", 33.7701, -118.1937),
    city("anaheim", "Anaheim", 33.8366, -117.9143),
    city("santa-barbara", "Santa Barbara", 34.4208, -119.6982),
    city("berkeley", "Berkeley", 37.8715, -122.273),
    city("pasadena", "Pasadena", 34.1478, -118.1445),
    city("irvine", "Irvine", 33.6846, -117.8265)
  ], ["CA"]),
  region("co", "Colorado", 39.7392, -104.9903, [
    city("denver", "Denver", 39.7392, -104.9903),
    city("colorado-springs", "Colorado Springs", 38.8339, -104.8214),
    city("boulder", "Boulder", 40.015, -105.2705),
    city("aspen", "Aspen", 39.1911, -106.8175)
  ], ["CO"]),
  region("ct", "Connecticut", 41.7658, -72.6734, [
    city("hartford", "Hartford", 41.7658, -72.6734),
    city("new-haven", "New Haven", 41.3083, -72.9279)
  ], ["CT"]),
  region("de", "Delaware", 39.7391, -75.5398, [
    city("wilmington", "Wilmington", 39.7391, -75.5398),
    city("dover", "Dover", 39.1582, -75.5244)
  ], ["DE"]),
  region("dc", "District of Columbia", 38.9072, -77.0369, [
    city("washington", "Washington", 38.9072, -77.0369, ["DC", "D.C."])
  ], ["DC", "Washington DC"]),
  region("fl", "Florida", 30.4383, -84.2807, [
    city("miami", "Miami", 25.7617, -80.1918),
    city("orlando", "Orlando", 28.5383, -81.3792),
    city("tampa", "Tampa", 27.9506, -82.4572),
    city("jacksonville", "Jacksonville", 30.3322, -81.6557),
    city("tallahassee", "Tallahassee", 30.4383, -84.2807)
  ], ["FL"]),
  region("ga", "Georgia", 33.749, -84.388, [
    city("atlanta", "Atlanta", 33.749, -84.388),
    city("savannah", "Savannah", 32.0809, -81.0912),
    city("augusta", "Augusta", 33.4735, -82.0105)
  ], ["GA"]),
  region("hi", "Hawaii", 21.3069, -157.8583, [
    city("honolulu", "Honolulu", 21.3069, -157.8583),
    city("hilo", "Hilo", 19.7074, -155.0885)
  ], ["HI"]),
  region("id", "Idaho", 43.615, -116.2023, [
    city("boise", "Boise", 43.615, -116.2023)
  ], ["ID"]),
  region("il", "Illinois", 39.7817, -89.6501, [
    city("chicago", "Chicago", 41.8781, -87.6298),
    city("springfield", "Springfield", 39.7817, -89.6501)
  ], ["IL"]),
  region("in", "Indiana", 39.7684, -86.1581, [
    city("indianapolis", "Indianapolis", 39.7684, -86.1581)
  ], ["IN"]),
  region("ia", "Iowa", 41.5868, -93.625, [
    city("des-moines", "Des Moines", 41.5868, -93.625)
  ], ["IA"]),
  region("ks", "Kansas", 39.0473, -95.6752, [
    city("wichita", "Wichita", 37.6872, -97.3301),
    city("topeka", "Topeka", 39.0473, -95.6752),
    city("kansas-city", "Kansas City", 39.1142, -94.6275)
  ], ["KS"]),
  region("ky", "Kentucky", 38.2527, -85.7585, [
    city("louisville", "Louisville", 38.2527, -85.7585),
    city("lexington", "Lexington", 38.0406, -84.5037)
  ], ["KY"]),
  region("la", "Louisiana", 30.4515, -91.1871, [
    city("new-orleans", "New Orleans", 29.9511, -90.0715),
    city("baton-rouge", "Baton Rouge", 30.4515, -91.1871)
  ], ["LA"]),
  region("me", "Maine", 43.6591, -70.2568, [
    city("portland", "Portland", 43.6591, -70.2568),
    city("augusta", "Augusta", 44.3106, -69.7795)
  ], ["ME"]),
  region("md", "Maryland", 38.9784, -76.4922, [
    city("baltimore", "Baltimore", 39.2904, -76.6122),
    city("annapolis", "Annapolis", 38.9784, -76.4922)
  ], ["MD"]),
  region("ma", "Massachusetts", 42.3601, -71.0589, [
    city("boston", "Boston", 42.3601, -71.0589),
    city("cambridge", "Cambridge", 42.3736, -71.1097),
    city("worcester", "Worcester", 42.2626, -71.8023),
    city("springfield", "Springfield", 42.1015, -72.5898)
  ], ["MA"]),
  region("mi", "Michigan", 42.3314, -83.0458, [
    city("detroit", "Detroit", 42.3314, -83.0458),
    city("ann-arbor", "Ann Arbor", 42.2808, -83.743),
    city("grand-rapids", "Grand Rapids", 42.9634, -85.6681)
  ], ["MI"]),
  region("mn", "Minnesota", 44.9778, -93.265, [
    city("minneapolis", "Minneapolis", 44.9778, -93.265),
    city("saint-paul", "Saint Paul", 44.9537, -93.09)
  ], ["MN"]),
  region("ms", "Mississippi", 32.2988, -90.1848, [
    city("jackson", "Jackson", 32.2988, -90.1848)
  ], ["MS"]),
  region("mo", "Missouri", 38.627, -90.1994, [
    city("st-louis", "St. Louis", 38.627, -90.1994),
    city("kansas-city", "Kansas City", 39.0997, -94.5786),
    city("springfield", "Springfield", 37.209, -93.2923)
  ], ["MO"]),
  region("mt", "Montana", 46.5891, -112.0391, [
    city("billings", "Billings", 45.7833, -108.5007),
    city("helena", "Helena", 46.5891, -112.0391)
  ], ["MT"]),
  region("ne", "Nebraska", 41.2565, -95.9345, [
    city("omaha", "Omaha", 41.2565, -95.9345),
    city("lincoln", "Lincoln", 40.8136, -96.7026)
  ], ["NE"]),
  region("nv", "Nevada", 36.1699, -115.1398, [
    city("las-vegas", "Las Vegas", 36.1699, -115.1398),
    city("reno", "Reno", 39.5296, -119.8138)
  ], ["NV"]),
  region("nh", "New Hampshire", 43.2081, -71.5376, [
    city("manchester", "Manchester", 42.9956, -71.4548),
    city("concord", "Concord", 43.2081, -71.5376)
  ], ["NH"]),
  region("nj", "New Jersey", 40.2206, -74.7597, [
    city("newark", "Newark", 40.7357, -74.1724),
    city("jersey-city", "Jersey City", 40.7178, -74.0431),
    city("trenton", "Trenton", 40.2206, -74.7597)
  ], ["NJ"]),
  region("nm", "New Mexico", 35.687, -105.9378, [
    city("albuquerque", "Albuquerque", 35.0844, -106.6504),
    city("santa-fe", "Santa Fe", 35.687, -105.9378)
  ], ["NM"]),
  region("ny", "New York", 42.6526, -73.7562, [
    city("new-york", "New York", 40.7128, -74.006, ["NYC", "New York City"]),
    city("buffalo", "Buffalo", 42.8864, -78.8784),
    city("rochester", "Rochester", 43.1566, -77.6088),
    city("albany", "Albany", 42.6526, -73.7562)
  ], ["NY"]),
  region("nc", "North Carolina", 35.7796, -78.6382, [
    city("charlotte", "Charlotte", 35.2271, -80.8431),
    city("raleigh", "Raleigh", 35.7796, -78.6382),
    city("durham", "Durham", 35.994, -78.8986),
    city("asheville", "Asheville", 35.5951, -82.5515)
  ], ["NC"]),
  region("nd", "North Dakota", 46.8083, -100.7837, [
    city("fargo", "Fargo", 46.8772, -96.7898),
    city("bismarck", "Bismarck", 46.8083, -100.7837)
  ], ["ND"]),
  region("oh", "Ohio", 39.9612, -82.9988, [
    city("columbus", "Columbus", 39.9612, -82.9988),
    city("cleveland", "Cleveland", 41.4993, -81.6944),
    city("cincinnati", "Cincinnati", 39.1031, -84.512)
  ], ["OH"]),
  region("ok", "Oklahoma", 35.4676, -97.5164, [
    city("oklahoma-city", "Oklahoma City", 35.4676, -97.5164),
    city("tulsa", "Tulsa", 36.154, -95.9928)
  ], ["OK"]),
  region("or", "Oregon", 44.9429, -123.0351, [
    city("portland", "Portland", 45.5152, -122.6784),
    city("salem", "Salem", 44.9429, -123.0351),
    city("eugene", "Eugene", 44.0521, -123.0868)
  ], ["OR"]),
  region("pa", "Pennsylvania", 40.2732, -76.8867, [
    city("philadelphia", "Philadelphia", 39.9526, -75.1652),
    city("pittsburgh", "Pittsburgh", 40.4406, -79.9959),
    city("harrisburg", "Harrisburg", 40.2732, -76.8867)
  ], ["PA"]),
  region("ri", "Rhode Island", 41.824, -71.4128, [
    city("providence", "Providence", 41.824, -71.4128)
  ], ["RI"]),
  region("sc", "South Carolina", 34.0007, -81.0348, [
    city("charleston", "Charleston", 32.7765, -79.9311),
    city("columbia", "Columbia", 34.0007, -81.0348)
  ], ["SC"]),
  region("sd", "South Dakota", 44.3668, -100.3538, [
    city("sioux-falls", "Sioux Falls", 43.5446, -96.7311),
    city("pierre", "Pierre", 44.3668, -100.3538)
  ], ["SD"]),
  region("tn", "Tennessee", 36.1627, -86.7816, [
    city("nashville", "Nashville", 36.1627, -86.7816),
    city("memphis", "Memphis", 35.1495, -90.049),
    city("knoxville", "Knoxville", 35.9606, -83.9207)
  ], ["TN"]),
  region("tx", "Texas", 30.2672, -97.7431, [
    city("houston", "Houston", 29.7604, -95.3698),
    city("dallas", "Dallas", 32.7767, -96.797),
    city("austin", "Austin", 30.2672, -97.7431),
    city("san-antonio", "San Antonio", 29.4241, -98.4936),
    city("fort-worth", "Fort Worth", 32.7555, -97.3308),
    city("el-paso", "El Paso", 31.7619, -106.485)
  ], ["TX"]),
  region("ut", "Utah", 40.7608, -111.891, [
    city("salt-lake-city", "Salt Lake City", 40.7608, -111.891),
    city("provo", "Provo", 40.2338, -111.6585)
  ], ["UT"]),
  region("vt", "Vermont", 44.2601, -72.5754, [
    city("burlington", "Burlington", 44.4759, -73.2121),
    city("montpelier", "Montpelier", 44.2601, -72.5754)
  ], ["VT"]),
  region("va", "Virginia", 37.5407, -77.436, [
    city("richmond", "Richmond", 37.5407, -77.436),
    city("virginia-beach", "Virginia Beach", 36.8529, -75.978),
    city("arlington", "Arlington", 38.8816, -77.091)
  ], ["VA"]),
  region("wa", "Washington", 47.0379, -122.9007, [
    city("seattle", "Seattle", 47.6062, -122.3321),
    city("spokane", "Spokane", 47.6588, -117.426),
    city("tacoma", "Tacoma", 47.2529, -122.4443),
    city("olympia", "Olympia", 47.0379, -122.9007)
  ], ["WA"]),
  region("wv", "West Virginia", 38.3498, -81.6326, [
    city("charleston", "Charleston", 38.3498, -81.6326)
  ], ["WV"]),
  region("wi", "Wisconsin", 43.0731, -89.4012, [
    city("milwaukee", "Milwaukee", 43.0389, -87.9065),
    city("madison", "Madison", 43.0731, -89.4012)
  ], ["WI"]),
  region("wy", "Wyoming", 41.14, -104.8202, [
    city("cheyenne", "Cheyenne", 41.14, -104.8202)
  ], ["WY"])
];

const COUNTRIES = [
  country("us", "United States", 38.9072, -77.0369, {
    aliases: ["USA", "America", "United States of America"],
    regions: US_REGIONS
  }),
  country("ca", "Canada", 45.4215, -75.6972, {
    aliases: ["CAN"],
    regions: [
      region("on", "Ontario", 43.6532, -79.3832, [
        city("toronto", "Toronto", 43.6532, -79.3832),
        city("ottawa", "Ottawa", 45.4215, -75.6972)
      ]),
      region("qc", "Quebec", 45.5017, -73.5673, [
        city("montreal", "Montreal", 45.5017, -73.5673),
        city("quebec-city", "Quebec City", 46.8139, -71.208)
      ], ["Québec"]),
      region("bc", "British Columbia", 49.2827, -123.1207, [
        city("vancouver", "Vancouver", 49.2827, -123.1207),
        city("victoria", "Victoria", 48.4284, -123.3656)
      ]),
      region("ab", "Alberta", 51.0447, -114.0719, [
        city("calgary", "Calgary", 51.0447, -114.0719),
        city("edmonton", "Edmonton", 53.5461, -113.4938)
      ])
    ]
  }),
  country("mx", "Mexico", 19.4326, -99.1332, {
    cities: [
      city("mexico-city", "Mexico City", 19.4326, -99.1332, ["CDMX"]),
      city("guadalajara", "Guadalajara", 20.6597, -103.3496),
      city("monterrey", "Monterrey", 25.6866, -100.3161),
      city("cancun", "Cancún", 21.1619, -86.8515),
      city("tijuana", "Tijuana", 32.5149, -117.0382)
    ]
  }),
  country("gb", "United Kingdom", 51.5074, -0.1278, {
    aliases: ["UK", "Britain", "Great Britain"],
    regions: [
      region("eng", "England", 51.5074, -0.1278, [
        city("london", "London", 51.5074, -0.1278),
        city("manchester", "Manchester", 53.4808, -2.2426),
        city("birmingham", "Birmingham", 52.4862, -1.8904),
        city("liverpool", "Liverpool", 53.4084, -2.9916),
        city("bristol", "Bristol", 51.4545, -2.5879),
        city("leeds", "Leeds", 53.8008, -1.5491)
      ]),
      region("sct", "Scotland", 55.9533, -3.1883, [
        city("edinburgh", "Edinburgh", 55.9533, -3.1883),
        city("glasgow", "Glasgow", 55.8642, -4.2518)
      ]),
      region("wls", "Wales", 51.4816, -3.1791, [
        city("cardiff", "Cardiff", 51.4816, -3.1791)
      ]),
      region("nir", "Northern Ireland", 54.5973, -5.9301, [
        city("belfast", "Belfast", 54.5973, -5.9301)
      ])
    ]
  }),
  country("ie", "Ireland", 53.3498, -6.2603, {
    cities: [city("dublin", "Dublin", 53.3498, -6.2603), city("cork", "Cork", 51.8985, -8.4756)]
  }),
  country("fr", "France", 48.8566, 2.3522, {
    cities: [
      city("paris", "Paris", 48.8566, 2.3522),
      city("lyon", "Lyon", 45.764, 4.8357),
      city("marseille", "Marseille", 43.2965, 5.3698),
      city("toulouse", "Toulouse", 43.6047, 1.4442),
      city("nice", "Nice", 43.7102, 7.262)
    ]
  }),
  country("de", "Germany", 52.52, 13.405, {
    cities: [
      city("berlin", "Berlin", 52.52, 13.405),
      city("munich", "Munich", 48.1351, 11.582, ["München"]),
      city("hamburg", "Hamburg", 53.5511, 9.9937),
      city("frankfurt", "Frankfurt", 50.1109, 8.6821),
      city("cologne", "Cologne", 50.9375, 6.9603, ["Köln"])
    ]
  }),
  country("it", "Italy", 41.9028, 12.4964, {
    cities: [
      city("rome", "Rome", 41.9028, 12.4964, ["Roma"]),
      city("milan", "Milan", 45.4642, 9.19, ["Milano"]),
      city("florence", "Florence", 43.7696, 11.2558, ["Firenze"]),
      city("naples", "Naples", 40.8518, 14.2681, ["Napoli"]),
      city("venice", "Venice", 45.4408, 12.3155, ["Venezia"])
    ]
  }),
  country("es", "Spain", 40.4168, -3.7038, {
    cities: [
      city("madrid", "Madrid", 40.4168, -3.7038),
      city("barcelona", "Barcelona", 41.3874, 2.1686),
      city("seville", "Seville", 37.3891, -5.9845, ["Sevilla"]),
      city("valencia", "Valencia", 39.4699, -0.3763)
    ]
  }),
  country("pt", "Portugal", 38.7223, -9.1393, {
    cities: [city("lisbon", "Lisbon", 38.7223, -9.1393, ["Lisboa"]), city("porto", "Porto", 41.1579, -8.6291)]
  }),
  country("nl", "Netherlands", 52.3676, 4.9041, {
    aliases: ["Holland"],
    cities: [city("amsterdam", "Amsterdam", 52.3676, 4.9041), city("rotterdam", "Rotterdam", 51.9244, 4.4777), city("the-hague", "The Hague", 52.0705, 4.3007)]
  }),
  country("be", "Belgium", 50.8503, 4.3517, {
    cities: [city("brussels", "Brussels", 50.8503, 4.3517), city("antwerp", "Antwerp", 51.2194, 4.4025)]
  }),
  country("ch", "Switzerland", 46.948, 7.4474, {
    cities: [city("zurich", "Zurich", 47.3769, 8.5417), city("geneva", "Geneva", 46.2044, 6.1432), city("bern", "Bern", 46.948, 7.4474)]
  }),
  country("at", "Austria", 48.2082, 16.3738, {
    cities: [city("vienna", "Vienna", 48.2082, 16.3738, ["Wien"])]
  }),
  country("se", "Sweden", 59.3293, 18.0686, {
    cities: [city("stockholm", "Stockholm", 59.3293, 18.0686), city("gothenburg", "Gothenburg", 57.7089, 11.9746)]
  }),
  country("no", "Norway", 59.9139, 10.7522, {
    cities: [city("oslo", "Oslo", 59.9139, 10.7522), city("bergen", "Bergen", 60.3913, 5.3221)]
  }),
  country("dk", "Denmark", 55.6761, 12.5683, {
    cities: [city("copenhagen", "Copenhagen", 55.6761, 12.5683)]
  }),
  country("fi", "Finland", 60.1699, 24.9384, {
    cities: [city("helsinki", "Helsinki", 60.1699, 24.9384)]
  }),
  country("pl", "Poland", 52.2297, 21.0122, {
    cities: [city("warsaw", "Warsaw", 52.2297, 21.0122), city("krakow", "Kraków", 50.0647, 19.945)]
  }),
  country("cz", "Czechia", 50.0755, 14.4378, {
    aliases: ["Czech Republic"],
    cities: [city("prague", "Prague", 50.0755, 14.4378)]
  }),
  country("gr", "Greece", 37.9838, 23.7275, {
    cities: [city("athens", "Athens", 37.9838, 23.7275)]
  }),
  country("tr", "Turkey", 39.9334, 32.8597, {
    cities: [city("istanbul", "Istanbul", 41.0082, 28.9784), city("ankara", "Ankara", 39.9334, 32.8597)]
  }),
  country("ru", "Russia", 55.7558, 37.6173, {
    cities: [city("moscow", "Moscow", 55.7558, 37.6173), city("saint-petersburg", "Saint Petersburg", 59.9343, 30.3351)]
  }),
  country("ua", "Ukraine", 50.4501, 30.5234, {
    cities: [city("kyiv", "Kyiv", 50.4501, 30.5234, ["Kiev"])]
  }),
  country("il", "Israel", 31.7683, 35.2137, {
    cities: [city("jerusalem", "Jerusalem", 31.7683, 35.2137), city("tel-aviv", "Tel Aviv", 32.0853, 34.7818)]
  }),
  country("eg", "Egypt", 30.0444, 31.2357, {
    cities: [city("cairo", "Cairo", 30.0444, 31.2357), city("alexandria", "Alexandria", 31.2001, 29.9187)]
  }),
  country("za", "South Africa", -25.7479, 28.2293, {
    cities: [
      city("johannesburg", "Johannesburg", -26.2041, 28.0473),
      city("cape-town", "Cape Town", -33.9249, 18.4241),
      city("pretoria", "Pretoria", -25.7479, 28.2293)
    ]
  }),
  country("ng", "Nigeria", 9.0765, 7.3986, {
    cities: [city("lagos", "Lagos", 6.5244, 3.3792), city("abuja", "Abuja", 9.0765, 7.3986)]
  }),
  country("ke", "Kenya", -1.2921, 36.8219, {
    cities: [city("nairobi", "Nairobi", -1.2921, 36.8219)]
  }),
  country("ma", "Morocco", 34.0209, -6.8416, {
    cities: [city("rabat", "Rabat", 34.0209, -6.8416), city("casablanca", "Casablanca", 33.5731, -7.5898), city("marrakesh", "Marrakesh", 31.6295, -7.9811)]
  }),
  country("ae", "United Arab Emirates", 24.4539, 54.3773, {
    aliases: ["UAE"],
    cities: [city("dubai", "Dubai", 25.2048, 55.2708), city("abu-dhabi", "Abu Dhabi", 24.4539, 54.3773)]
  }),
  country("sa", "Saudi Arabia", 24.7136, 46.6753, {
    cities: [city("riyadh", "Riyadh", 24.7136, 46.6753), city("jeddah", "Jeddah", 21.4858, 39.1925)]
  }),
  country("in", "India", 28.6139, 77.209, {
    cities: [
      city("new-delhi", "New Delhi", 28.6139, 77.209, ["Delhi"]),
      city("mumbai", "Mumbai", 19.076, 72.8777, ["Bombay"]),
      city("bengaluru", "Bengaluru", 12.9716, 77.5946, ["Bangalore"]),
      city("chennai", "Chennai", 13.0827, 80.2707),
      city("kolkata", "Kolkata", 22.5726, 88.3639)
    ]
  }),
  country("pk", "Pakistan", 33.6844, 73.0479, {
    cities: [city("islamabad", "Islamabad", 33.6844, 73.0479), city("karachi", "Karachi", 24.8607, 67.0011), city("lahore", "Lahore", 31.5204, 74.3587)]
  }),
  country("bd", "Bangladesh", 23.8103, 90.4125, {
    cities: [city("dhaka", "Dhaka", 23.8103, 90.4125)]
  }),
  country("cn", "China", 39.9042, 116.4074, {
    cities: [
      city("beijing", "Beijing", 39.9042, 116.4074),
      city("shanghai", "Shanghai", 31.2304, 121.4737),
      city("guangzhou", "Guangzhou", 23.1291, 113.2644),
      city("shenzhen", "Shenzhen", 22.5431, 114.0579),
      city("hong-kong", "Hong Kong", 22.3193, 114.1694)
    ]
  }),
  country("jp", "Japan", 35.6762, 139.6503, {
    cities: [
      city("tokyo", "Tokyo", 35.6762, 139.6503),
      city("osaka", "Osaka", 34.6937, 135.5023),
      city("kyoto", "Kyoto", 35.0116, 135.7681),
      city("yokohama", "Yokohama", 35.4437, 139.638)
    ]
  }),
  country("kr", "South Korea", 37.5665, 126.978, {
    cities: [city("seoul", "Seoul", 37.5665, 126.978), city("busan", "Busan", 35.1796, 129.0756)]
  }),
  country("tw", "Taiwan", 25.033, 121.5654, {
    cities: [city("taipei", "Taipei", 25.033, 121.5654)]
  }),
  country("th", "Thailand", 13.7563, 100.5018, {
    cities: [city("bangkok", "Bangkok", 13.7563, 100.5018)]
  }),
  country("vn", "Vietnam", 21.0278, 105.8342, {
    cities: [city("hanoi", "Hanoi", 21.0278, 105.8342), city("ho-chi-minh-city", "Ho Chi Minh City", 10.8231, 106.6297, ["Saigon"])]
  }),
  country("id", "Indonesia", -6.2088, 106.8456, {
    cities: [city("jakarta", "Jakarta", -6.2088, 106.8456), city("bali", "Denpasar", -8.6705, 115.2126, ["Bali"])]
  }),
  country("my", "Malaysia", 3.139, 101.6869, {
    cities: [city("kuala-lumpur", "Kuala Lumpur", 3.139, 101.6869)]
  }),
  country("sg", "Singapore", 1.3521, 103.8198, {
    cities: [city("singapore", "Singapore", 1.3521, 103.8198)]
  }),
  country("ph", "Philippines", 14.5995, 120.9842, {
    cities: [city("manila", "Manila", 14.5995, 120.9842)]
  }),
  country("au", "Australia", -35.2809, 149.13, {
    regions: [
      region("nsw", "New South Wales", -33.8688, 151.2093, [
        city("sydney", "Sydney", -33.8688, 151.2093)
      ]),
      region("vic", "Victoria", -37.8136, 144.9631, [
        city("melbourne", "Melbourne", -37.8136, 144.9631)
      ]),
      region("qld", "Queensland", -27.4698, 153.0251, [
        city("brisbane", "Brisbane", -27.4698, 153.0251)
      ]),
      region("wa", "Western Australia", -31.9505, 115.8605, [
        city("perth", "Perth", -31.9505, 115.8605)
      ]),
      region("sa", "South Australia", -34.9285, 138.6007, [
        city("adelaide", "Adelaide", -34.9285, 138.6007)
      ]),
      region("act", "Australian Capital Territory", -35.2809, 149.13, [
        city("canberra", "Canberra", -35.2809, 149.13)
      ]),
      region("tas", "Tasmania", -42.8821, 147.3272, [
        city("hobart", "Hobart", -42.8821, 147.3272)
      ]),
      region("nt", "Northern Territory", -12.4634, 130.8456, [
        city("darwin", "Darwin", -12.4634, 130.8456)
      ])
    ]
  }),
  country("nz", "New Zealand", -41.2865, 174.7762, {
    cities: [city("wellington", "Wellington", -41.2865, 174.7762), city("auckland", "Auckland", -36.8509, 174.7645), city("christchurch", "Christchurch", -43.5321, 172.6362)]
  }),
  country("br", "Brazil", -15.7975, -47.8919, {
    cities: [
      city("brasilia", "Brasília", -15.7975, -47.8919),
      city("sao-paulo", "São Paulo", -23.5558, -46.6396),
      city("rio-de-janeiro", "Rio de Janeiro", -22.9068, -43.1729)
    ]
  }),
  country("ar", "Argentina", -34.6037, -58.3816, {
    cities: [city("buenos-aires", "Buenos Aires", -34.6037, -58.3816)]
  }),
  country("cl", "Chile", -33.4489, -70.6693, {
    cities: [city("santiago", "Santiago", -33.4489, -70.6693)]
  }),
  country("co", "Colombia", 4.711, -74.0721, {
    cities: [city("bogota", "Bogotá", 4.711, -74.0721)]
  }),
  country("pe", "Peru", -12.0464, -77.0428, {
    cities: [city("lima", "Lima", -12.0464, -77.0428)]
  }),
  country("ve", "Venezuela", 10.4806, -66.9036, {
    cities: [city("caracas", "Caracas", 10.4806, -66.9036)]
  })
];

module.exports = {
  countries: COUNTRIES
};
