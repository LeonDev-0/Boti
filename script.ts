import { prisma } from './lib/prisma'

async function main() {
  const users = await prisma.user.findMany()
  console.log('Todos los usuarios:', users)
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
