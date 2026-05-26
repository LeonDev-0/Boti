-- CreateTable
CREATE TABLE "Transaccion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tipo" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "precio" REAL NOT NULL,
    "creditos" REAL NOT NULL,
    "costo" REAL NOT NULL,
    "ganancia" REAL NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
