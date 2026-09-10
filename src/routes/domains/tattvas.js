const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const {
  createEntityNotFound,
  findByNormalizedCandidates
} = require("./shared");

const router = createApiRouter();

function listTattvas(magickDataset) {
  const source = magickDataset?.grouped?.alchemy?.tattvas;
  if (Array.isArray(source)) {
    return source;
  }
  if (source && typeof source === "object") {
    return Object.values(source);
  }
  return [];
}

function tattvaName(entry) {
  if (!entry) {
    return "";
  }
  if (typeof entry.name === "string") {
    return entry.name;
  }
  return entry.name?.en || "";
}

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.alchemy?.tattvas || {});
});

router.get("/:tattvaId", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const tattvas = magickDataset?.grouped?.alchemy?.tattvas;
  const tattvaId = String(request.params.tattvaId || "").trim();
  const tattva = tattvas?.[tattvaId]
    || tattvas?.[tattvaId.toLowerCase()]
    || findByNormalizedCandidates(
      listTattvas(magickDataset),
      tattvaId,
      (entry) => [
        entry?.id,
        tattvaName(entry),
        entry?.sanskrit,
        String(tattvaName(entry) || "").replace(/\s+/g, "-"),
        String(tattvaName(entry) || "").replace(/\s+of\s+/gi, "-of-")
      ]
    );
  if (!tattva) {
    throw createEntityNotFound("tattva", request.params.tattvaId);
  }

  response.apiSuccess(tattva);
});

module.exports = router;
