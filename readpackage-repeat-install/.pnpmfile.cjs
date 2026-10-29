// Turns a `root:*` placeholder into `workspace:*`, the way a monorepo hook resolves a shorthand to
// the version its root pins.
module.exports = {
	hooks: {
		readPackage(pkg) {
			for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
				if (range === 'root:*') pkg.dependencies[name] = 'workspace:*';
			}
			return pkg;
		},
	},
};
