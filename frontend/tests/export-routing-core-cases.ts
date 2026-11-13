import { writeFileSync } from 'node:fs'
import { coreVectors } from './routing-generator-cases'
writeFileSync(process.argv[2] ?? '/tmp/xkeen-routing-core-cases.json', JSON.stringify(coreVectors()))
