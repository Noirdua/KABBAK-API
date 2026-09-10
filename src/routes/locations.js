const { createApiRouter } = require("../lib/create-api-router");
const {
  listCountries,
  listRegions,
  listCities,
  searchPlaces,
  requirePlace
} = require("../services/location-gazetteer");

const router = createApiRouter();

router.get("/locations/countries", (_request, response) => {
  const countries = listCountries();
  response.apiSuccess({ count: countries.length, countries });
});

router.get("/locations/regions", (request, response) => {
  const regions = listRegions(request.query.country || request.query.countryId);
  response.apiSuccess({ count: regions.length, regions });
});

router.get("/locations/cities", (request, response) => {
  const cities = listCities(
    request.query.country || request.query.countryId,
    request.query.region || request.query.regionId
  );
  response.apiSuccess({ count: cities.length, cities });
});

router.get("/locations/search", (request, response) => {
  const places = searchPlaces(request.query.q, {
    countryId: request.query.country || request.query.countryId,
    regionId: request.query.region || request.query.regionId
  });
  response.apiSuccess({ count: places.length, places });
});

router.get("/locations/resolve", (request, response) => {
  const place = requirePlace(request.query);
  response.apiSuccess(place);
});

module.exports = router;
