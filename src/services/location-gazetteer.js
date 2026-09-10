const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const { countries: rawCountries } = require("../data/gazetteer");

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeKey(value) {
  return slug(value).replace(/-/g, "");
}

function haystack(entry) {
  return [entry.id, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
    .map((part) => String(part || "").toLowerCase())
    .join(" ");
}

function matchesQuery(entry, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const compact = q.replace(/[^a-z0-9]+/g, "");
  if (normalizeKey(entry.id).startsWith(compact) || normalizeKey(entry.name).startsWith(compact)) return true;
  return haystack(entry).includes(q) || (compact && haystack(entry).replace(/[^a-z0-9]+/g, "").includes(compact));
}

function summarizeCountry(country) {
  return {
    id: country.id,
    name: country.name,
    aliases: [...(country.aliases || [])],
    latitude: country.latitude,
    longitude: country.longitude,
    regionCount: country.regions.length,
    cityCount: country.cities.length + country.regions.reduce((sum, region) => sum + region.cities.length, 0)
  };
}

function summarizeRegion(region, country) {
  return {
    id: region.id,
    name: region.name,
    aliases: [...(region.aliases || [])],
    countryId: country.id,
    countryName: country.name,
    latitude: region.latitude,
    longitude: region.longitude,
    cityCount: region.cities.length
  };
}

function summarizeCity(city, country, region = null) {
  return {
    id: city.id,
    name: city.name,
    aliases: [...(city.aliases || [])],
    countryId: country.id,
    countryName: country.name,
    regionId: region ? region.id : "",
    regionName: region ? region.name : "",
    latitude: city.latitude,
    longitude: city.longitude
  };
}

function placeLabel(parts) {
  return parts.filter(Boolean).join(", ");
}

function buildIndex() {
  const countries = [];
  const countryById = new Map();
  const regionById = new Map();
  const cityById = new Map();
  const places = [];

  rawCountries.forEach((rawCountry) => {
    const countryId = slug(rawCountry.id);
    const country = {
      id: countryId,
      name: rawCountry.name,
      aliases: rawCountry.aliases || [],
      latitude: rawCountry.latitude,
      longitude: rawCountry.longitude,
      regions: [],
      cities: []
    };
    countryById.set(countryId, country);
    countries.push(country);
    places.push({
      id: countryId,
      type: "country",
      label: country.name,
      latitude: country.latitude,
      longitude: country.longitude,
      countryId,
      regionId: "",
      cityId: ""
    });

    (rawCountry.regions || []).forEach((rawRegion) => {
      const regionId = `${countryId}-${slug(rawRegion.id)}`;
      const region = {
        id: regionId,
        localId: slug(rawRegion.id),
        name: rawRegion.name,
        aliases: rawRegion.aliases || [],
        latitude: rawRegion.latitude,
        longitude: rawRegion.longitude,
        country,
        cities: []
      };
      regionById.set(regionId, region);
      regionById.set(`${countryId}:${region.localId}`, region);
      country.regions.push(region);
      places.push({
        id: regionId,
        type: "region",
        label: placeLabel([region.name, country.name]),
        latitude: region.latitude,
        longitude: region.longitude,
        countryId,
        regionId,
        cityId: ""
      });

      (rawRegion.cities || []).forEach((rawCity) => {
        const cityLocal = slug(rawCity.id);
        const cityId = `${regionId}-${cityLocal}`;
        const city = {
          id: cityId,
          localId: cityLocal,
          name: rawCity.name,
          aliases: rawCity.aliases || [],
          latitude: rawCity.latitude,
          longitude: rawCity.longitude,
          country,
          region
        };
        cityById.set(cityId, city);
        cityById.set(`${countryId}:${region.localId}:${cityLocal}`, city);
        cityById.set(`${countryId}:${cityLocal}`, city);
        region.cities.push(city);
        places.push({
          id: cityId,
          type: "city",
          label: placeLabel([city.name, region.name, country.name]),
          latitude: city.latitude,
          longitude: city.longitude,
          countryId,
          regionId,
          cityId
        });
      });
    });

    (rawCountry.cities || []).forEach((rawCity) => {
      const cityLocal = slug(rawCity.id);
      const cityId = `${countryId}-${cityLocal}`;
      const city = {
        id: cityId,
        localId: cityLocal,
        name: rawCity.name,
        aliases: rawCity.aliases || [],
        latitude: rawCity.latitude,
        longitude: rawCity.longitude,
        country,
        region: null
      };
      cityById.set(cityId, city);
      cityById.set(`${countryId}:${cityLocal}`, city);
      country.cities.push(city);
      places.push({
        id: cityId,
        type: "city",
        label: placeLabel([city.name, country.name]),
        latitude: city.latitude,
        longitude: city.longitude,
        countryId,
        regionId: "",
        cityId
      });
    });
  });

  return { countries, countryById, regionById, cityById, places };
}

const index = buildIndex();

function findCountry(countryId) {
  const key = slug(countryId);
  return index.countryById.get(key) || null;
}

function findRegion(countryId, regionId) {
  const countryKey = slug(countryId);
  const regionKey = slug(regionId);
  if (!regionKey) return null;
  if (index.regionById.has(regionKey)) return index.regionById.get(regionKey);
  if (countryKey) {
    return index.regionById.get(`${countryKey}-${regionKey}`)
      || index.regionById.get(`${countryKey}:${regionKey}`)
      || null;
  }
  return null;
}

function findCity(countryId, regionId, cityId) {
  const countryKey = slug(countryId);
  const regionKey = slug(regionId);
  const cityKey = slug(cityId);
  if (!cityKey) return null;
  if (index.cityById.has(cityKey)) return index.cityById.get(cityKey);
  if (countryKey && regionKey) {
    return index.cityById.get(`${countryKey}-${regionKey}-${cityKey}`)
      || index.cityById.get(`${countryKey}:${regionKey}:${cityKey}`)
      || null;
  }
  if (countryKey) {
    return index.cityById.get(`${countryKey}-${cityKey}`)
      || index.cityById.get(`${countryKey}:${cityKey}`)
      || null;
  }
  return null;
}

function listCountries() {
  return index.countries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(summarizeCountry);
}

function listRegions(countryId) {
  if (!slug(countryId)) {
    throw createHttpError(400, "invalid_location_country", "country is required.");
  }
  const country = findCountry(countryId);
  if (!country) {
    throw createNotFoundError("location_country_not_found", `Unknown country '${countryId}'.`);
  }
  return country.regions.map((region) => summarizeRegion(region, country));
}

function listCities(countryId, regionId) {
  if (!slug(countryId)) {
    throw createHttpError(400, "invalid_location_country", "country is required.");
  }
  const country = findCountry(countryId);
  if (!country) {
    throw createNotFoundError("location_country_not_found", `Unknown country '${countryId}'.`);
  }
  if (regionId) {
    const region = findRegion(countryId, regionId);
    if (!region) {
      throw createNotFoundError("location_region_not_found", `Unknown region '${regionId}' in '${country.name}'.`);
    }
    return region.cities.map((city) => summarizeCity(city, country, region));
  }
  const nested = country.regions.flatMap((region) => region.cities.map((city) => summarizeCity(city, country, region)));
  return [...country.cities.map((city) => summarizeCity(city, country, null)), ...nested];
}

function searchPlaces(query, filters = {}) {
  const country = filters.countryId ? findCountry(filters.countryId) : null;
  if (filters.countryId && !country) {
    throw createNotFoundError("location_country_not_found", `Unknown country '${filters.countryId}'.`);
  }
  const region = filters.regionId ? findRegion(filters.countryId, filters.regionId) : null;
  const q = String(query || "").trim();
  return index.places
    .filter((place) => {
      if (country && place.countryId !== country.id) return false;
      if (region && place.regionId !== region.id) return false;
      return matchesQuery(place, q) || matchesQuery({ id: place.id, name: place.label, aliases: [] }, q);
    })
    .slice(0, 40);
}

function resolvePlace(input = {}) {
  const placeId = slug(input.placeId || input.id);
  if (placeId) {
    const byId = index.places.find((place) => place.id === placeId);
    if (byId) return byId;
  }

  const countryId = input.countryId || input.country;
  const regionId = input.regionId || input.region;
  const cityId = input.cityId || input.city;

  if (cityId) {
    const city = findCity(countryId, regionId, cityId);
    if (!city) {
      throw createNotFoundError("location_city_not_found", `Unknown city '${cityId}'.`);
    }
    return {
      id: city.id,
      type: "city",
      label: placeLabel([city.name, city.region?.name, city.country.name]),
      latitude: city.latitude,
      longitude: city.longitude,
      countryId: city.country.id,
      regionId: city.region ? city.region.id : "",
      cityId: city.id
    };
  }

  if (regionId) {
    const region = findRegion(countryId, regionId);
    if (!region) {
      throw createNotFoundError("location_region_not_found", `Unknown region '${regionId}'.`);
    }
    return {
      id: region.id,
      type: "region",
      label: placeLabel([region.name, region.country.name]),
      latitude: region.latitude,
      longitude: region.longitude,
      countryId: region.country.id,
      regionId: region.id,
      cityId: ""
    };
  }

  if (countryId) {
    const country = findCountry(countryId);
    if (!country) {
      throw createNotFoundError("location_country_not_found", `Unknown country '${countryId}'.`);
    }
    return {
      id: country.id,
      type: "country",
      label: country.name,
      latitude: country.latitude,
      longitude: country.longitude,
      countryId: country.id,
      regionId: "",
      cityId: ""
    };
  }

  return null;
}

function tryResolvePlace(input = {}) {
  const hasPlace = Boolean(
    input?.placeId || input?.id || input?.countryId || input?.country
    || input?.regionId || input?.region || input?.cityId || input?.city
  );
  if (!hasPlace) return null;
  return resolvePlace(input);
}

function requirePlace(input = {}) {
  const place = resolvePlace(input);
  if (!place) {
    throw createHttpError(400, "invalid_location_place", "Provide country, region, city, or placeId.");
  }
  return place;
}

module.exports = {
  listCountries,
  listRegions,
  listCities,
  searchPlaces,
  resolvePlace,
  tryResolvePlace,
  requirePlace
};
