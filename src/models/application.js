var _ = require("lodash");
var Bacon = require("baconjs");
var autocomplete = require("cliparse").autocomplete;
var Promise = require("bluebird");

var Logger = require("../logger.js");

var AppConfiguration = require("./app_configuration.js");
var Organisation = require("./organisation.js");

var Application = module.exports;

Application.listAvailableTypes = function() {
  return autocomplete.words([
    "docker",
    "go",
    "node",
    "static",
    "python",
    "php",
    "jar",
    "gradle",
    "war",
    "maven",
    "play1",
    "play2",
    "sbt",
    "ruby"
  ]);
};

Application.listAvailableZones = function() {
  return autocomplete.words([
    "par",
    "mtl"
  ]);
};

Application.listAvailableAliases = function() {
  var s_aliases = AppConfiguration.loadApplicationConf().map(function(conf) {
    return _.map(conf.apps, "alias");
  });

  return s_aliases.toPromise(Promise).then(autocomplete.words);
};

Application.listAvailableFlavors = function() {
  return [
    "pico",
    "nano",
    "XS",
    "S",
    "M",
    "L",
    "XL"
  ];
};

Application.configKeys = {
  "cancel-on-push": {
    jsonName: "cancelOnPush",
    type: "boolean"
  },
  "description": "description",
  "name": "name",
  "separate-build": {
    jsonName: "separateBuild",
    type: "boolean"
  },
  "sticky-sessions": {
    jsonName: "stickySessions",
    type: "boolean"
  },
  "zone": {
    jsonName: "zone",
    type: "zone"
  }
};

Application.listConfigKeys = function() {
  return autocomplete.words(Object.keys(Application.configKeys));
}

Application.getId = function(api, orgaId, appIdOrName) {
  if(appIdOrName.app_id) {
    return Bacon.once(appIdOrName.app_id);
  } else {
    return Application.getByName(api, appIdOrName.app_name, orgaId && { orga_id: orgaId }).map(function(app) {
      return app.id;
    });
  }
};

Application.getInstanceType = function(api, type) {
  var s_types = api.products.instances.get().send();

  return s_types.flatMapLatest(function(types) {
    var matchingTypes = _.filter(types, function(instanceType) {
      return instanceType.type == type || (instanceType.variant && instanceType.variant.slug == type);
    });

    var instanceType = _.sortBy(matchingTypes, "version").reverse()[0];
    return instanceType ? Bacon.once(instanceType) : new Bacon.Error(type + " type does not exist.");
  });
};

Application.create = function(api, name, instanceType, region, orgaIdOrName, github) {
  Logger.debug("Create the application…");
  return Organisation.getId(api, orgaIdOrName).flatMapLatest(function(orgaId) {
    var params = orgaId ? [orgaId] : [];

    var body = {
      "deploy": "git",
      "description": name,
      "instanceType": instanceType.type,
      "instanceVersion": instanceType.version,
      "maxFlavor": "S",
      "maxInstances": 1,
      "minFlavor": "S",
      "minInstances": 1,
      "name": name,
      "zone": region
    };

    if(github) {
      body.oauthService = "github";
      body.oauthApp = github;
    }

    return api.owner(orgaId).applications.post().withParams(params).send(JSON.stringify(body));
  });
};

var getApplicationByName = function(s_apps, name) {
  var s_app = s_apps.flatMapLatest(function(apps) {
    var filtered_apps = _.filter(apps, function(app) {
      return app.name === name;
    });
    if(filtered_apps.length === 1) {
      return Bacon.once(filtered_apps[0]);
    } else if(filtered_apps.length === 0) {
      return Bacon.once(new Bacon.Error("Application not found"));
    } else {
      return Bacon.once(new Bacon.Error("Ambiguous application name"));
    }
  });

  return s_app;
};

Application.getByName = function(api, name, orgaIdOrName) {
  if(!orgaIdOrName) {
    var s_apps = api.owner().applications.get().send()
    return getApplicationByName(s_apps, name);
  } else {
    var s_apps = Organisation.getId(api, orgaIdOrName).flatMapLatest(function(orgaId) {
      return api.owner(orgaId).applications.get().withParams([orgaId]).send();
    });
    return getApplicationByName(s_apps, name);
  }
};

Application.get = function(api, appId, orgaId) {
  Logger.debug("Get information for the app: " + appId);
  var params = orgaId ? [orgaId, appId] : [appId];

  return api.owner(orgaId).applications._.get().withParams(params).send();
};

Application.getInstances = function(api, appId, orgaId) {
  Logger.debug("Get instances for the app: " + appId);
  var params = orgaId ? [orgaId, appId] : [appId];

  return api.owner(orgaId).applications._.instances.get().withParams(params).send();
};

Application.linkRepo = function(api, appIdOrName, orgaIdOrName, alias) {
  Logger.debug("Linking current repository to the app: " + (appIdOrName.app_id || appIdOrName.app_name));

  var s_app;

  if(appIdOrName.app_id) {
    s_app = Application.get(api, appIdOrName.app_id)
  } else {
    s_app = Application.getByName(api, appIdOrName.app_name, orgaIdOrName);
  }

  return s_app.flatMapLatest(function(appData) {
    return AppConfiguration.addLinkedApplication(appData, alias);
  });
};

Application.unlinkRepo = function(api, alias) {
  Logger.debug("Unlinking current repository from the app: " + alias);

  return AppConfiguration.removeLinkedApplication(alias);
};

Application.stop = function(api, appId, orgaId) {
  Logger.debug("Stopping the app: " + appId);
  var params = orgaId ? [orgaId, appId] : [appId];

  return api.owner(orgaId).applications._.instances.delete().withParams(params).send();
};

Application.redeploy = function(api, appId, orgaId, commitId, withoutCache) {
  Logger.debug("Redeploying the app: " + appId);
  var params = orgaId ? [orgaId, appId] : [appId];
  var query = {};
  if(commitId) query.commit = commitId;
  if(withoutCache) query.useCache = "no";

  return api.owner(orgaId).applications._.instances.post()
    .withParams(params)
    .withQuery(query)
    .send();
};

Application.mergeScalabilityParameters = function(scalabilityParameters, instance) {
  var flavors = Application.listAvailableFlavors();

  if (scalabilityParameters.minFlavor) {
    instance.minFlavor = scalabilityParameters.minFlavor;
    if (flavors.indexOf(instance.minFlavor) > flavors.indexOf(instance.maxFlavor))
      instance.maxFlavor = instance.minFlavor;
  }
  if (scalabilityParameters.maxFlavor) {
    instance.maxFlavor = scalabilityParameters.maxFlavor;
    if (flavors.indexOf(instance.minFlavor) > flavors.indexOf(instance.maxFlavor) &&
        scalabilityParameters.minFlavor == null)
      instance.minFlavor = instance.maxFlavor;
  }

  if (scalabilityParameters.minInstances) {
    instance.minInstances = scalabilityParameters.minInstances;
    if (instance.minInstances > instance.maxInstances)
      instance.maxInstances = instance.minInstances;
  }
  if (scalabilityParameters.maxInstances) {
    instance.maxInstances = scalabilityParameters.maxInstances;
    if (instance.minInstances > instance.maxInstances && scalabilityParameters.minInstances == null)
      instance.minInstances = instance.maxInstances;
  }
  return instance;
}

Application.setScalability = function(api, appId, orgaId, scalabilityParameters) {
  Logger.info("Scaling the app: " + appId);

  var s_app = Application.get(api, appId, orgaId).toProperty();
  var s_body = s_app.map(function(app) {
    var instance = _.cloneDeep(app.instance);

    instance.minFlavor = instance.minFlavor.name;
    instance.maxFlavor = instance.maxFlavor.name;

    instance = Application.mergeScalabilityParameters(scalabilityParameters, instance);

    return instance;
  });

  return s_body.flatMapLatest(function(instance) {
    var params = orgaId ? [orgaId, appId] : [appId];
    return api.owner(orgaId).applications._.put().withParams(params).send(JSON.stringify(instance));
  })
};

Application.listDependencies = function(api, appId, orgaId, showAll) {
  var s_all = api.owner(orgaId).applications.get().withParams(orgaId ? [orgaId] : []).send();
  var s_mine = api.owner(orgaId).applications._.dependencies.get().withParams(orgaId ? [orgaId, appId] : [appId]).send();

  if(!showAll) {
    return s_mine;
  } else {
    return s_all.flatMapLatest(function(all) {
      return s_mine.flatMapLatest(function(mine) {
        var mineIds = _.map(mine, 'id');
        return _.map(all, function(app) {
          if(_.includes(mineIds, app.id)) {
            return _.assign({}, app, { isLinked: true });
          } else {
            return app;
          }
        });
      });
    });
  }
};

Application.link = function(api, appId, orgaId, appIdOrName) {
  var s_appIdToLink = Application.getId(api, orgaId, appIdOrName);

  return s_appIdToLink.flatMapLatest(function(appIdToLink) {
    var params = orgaId ? [orgaId, appId, appIdToLink] : [appId, appIdToLink];
    return api.owner(orgaId).applications._.dependencies._.put().withParams(params).send();
  });
};

Application.unlink = function(api, appId, orgaId, appIdOrName) {
  var s_linkedAppId = Application.getId(api, orgaId, appIdOrName);

  return s_linkedAppId.flatMapLatest(function(linkedAppId) {
    var params = orgaId ? [orgaId, appId, linkedAppId] : [appId, linkedAppId];
    return api.owner(orgaId).applications._.dependencies._.delete().withParams(params).send();
  });
};

Application.setConfigItem = function(api, appId, orgaId, key, value) {
  var params = orgaId ? [orgaId, appId] : [appId];
  var s_currentConfig = api.owner(orgaId).applications._.get().withParams(params).send();

  return s_currentConfig.flatMapLatest(function(currentConfig) {
    var newConfig = {
      cancelOnPush: currentConfig.cancelOnPush,
      description: currentConfig.description,
      homogeneous: false,
      id: appId,
      name: currentConfig.name,
      separateBuild: currentConfig.separateBuild,
      stickySessions: currentConfig.stickySessions,
      zone: currentConfig.zone
    };

    newConfig[key]  = value;

    return api.owner(orgaId).applications._.put().withParams(params).send(JSON.stringify(newConfig));
  });

};
