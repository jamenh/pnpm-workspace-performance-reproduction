// Rewrites a dependency's version range, here pointing a `*` range at the workspace package.
module.exports = {
	hooks: {
		readPackage(pkg) {
			if (pkg.dependencies?.['@repeat/shared'] === '*') {
				pkg.dependencies['@repeat/shared'] = 'workspace:*';
			}
			return pkg;
		},
	},
};
