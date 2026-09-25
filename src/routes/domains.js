const { createApiRouter } = require("../lib/create-api-router");
const astrologyRoutes = require("./domains/astrology");
const calendarRoutes = require("./domains/calendar");
const ichingRoutes = require("./domains/iching");
const kabbalahRoutes = require("./domains/kabbalah");
const alphabetsRoutes = require("./domains/alphabets");
const godsRoutes = require("./domains/gods");
const numbersRoutes = require("./domains/numbers");
const chakrasRoutes = require("./domains/chakras");
const tattvasRoutes = require("./domains/tattvas");
const enochianRoutes = require("./domains/enochian");
const playingCardsRoutes = require("./domains/playing-cards");
const gematriaRoutes = require("./domains/gematria");
const wordsRoutes = require("./domains/words");
const scriberRoutes = require("./domains/scriber");
const correspondenceRoutes = require("./domains/correspondences");

const router = createApiRouter();

router.use("/astrology", astrologyRoutes);
router.use("/calendar", calendarRoutes);
router.use("/iching", ichingRoutes);
router.use("/kabbalah", kabbalahRoutes);
router.use("/alphabets", alphabetsRoutes);
router.use("/gods", godsRoutes);
router.use("/numbers", numbersRoutes);
router.use("/chakras", chakrasRoutes);
router.use("/tattvas", tattvasRoutes);
router.use("/enochian", enochianRoutes);
router.use("/playing-cards", playingCardsRoutes);
router.use("/gematria", gematriaRoutes);
router.use("/words", wordsRoutes);
router.use("/scriber", scriberRoutes);
router.use("/correspondences", correspondenceRoutes);

module.exports = router;