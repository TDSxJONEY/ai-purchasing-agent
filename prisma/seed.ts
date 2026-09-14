import "dotenv/config";
import { prisma } from "../src/lib/db";
import { seedDatabase } from "../src/lib/seed";

async function main() {
  console.log("Wiping existing data...");
  const counts = await seedDatabase();
  console.log("\nSeed complete.");
  console.table(counts);
  console.log("\nScenarios ready:");
  console.log("  S1-A  MODIFY 250        Wireless Earbuds Pro @ Delhi NCR      (rec 800, storage-capped)");
  console.log("  S1-B  REJECT            Cola 500ml @ Mumbai West              (rec 800, demand covered)");
  console.log("  S1-C  REJECT + escalate Olive Oil 1L @ Bengaluru South        (rec 500, MOQ unreachable)");
  console.log("  S1-D  INVESTIGATE       Whey Protein 1kg @ Hyderabad Central  (rec 300, stale forecast)");
  console.log("  S1-E  ACCEPT 400        Toothpaste 150g @ Pune East           (rec 400, matches)");
  console.log("  S2-A  SUPPLEMENTARY PO  AA Batteries @ Chennai North          (500 ordered, 250 confirmed)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
