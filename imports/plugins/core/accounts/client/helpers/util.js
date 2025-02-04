import _ from "lodash";
import { Accounts } from "meteor/accounts-base";
import { ServiceConfiguration } from "meteor/service-configuration";

function capitalize(str) {
  const finalString = str === null ? "" : String(str);
  return finalString.charAt(0).toUpperCase() + str.slice(1);
}

const providers = {
  Facebook: {},
  Google: {},
  Twitter: {},
  Instagram: {}
};

providers.Facebook.fields = function () {
  return [
    { property: "appId", label: "App ID" },
    { property: "secret", label: "App Secret" }
  ];
};

providers.Google.fields = function () {
  return [
    { property: "clientId", label: "Client ID" },
    { property: "secret", label: "Client secret" }
  ];
};

providers.Twitter.fields = function () {
  return [
    { property: "consumerKey", label: "API key" },
    { property: "secret", label: "API secret" }
  ];
};

providers.Instagram.fields = function () {
  return [
    { property: "clientId", label: "Client ID" },
    { property: "secret", label: "Client secret" }
  ];
};


export class ServiceConfigHelper {
  availableServices() {
    const services = Package["accounts-oauth"] ? Accounts.oauth.serviceNames() : [];
    services.sort();

    return services;
  }

  capitalizedServiceName(name) {
    if (name === "meteor-developer") {
      return "MeteorDeveloperAccount";
    }

    return capitalize(name);
  }

  configFieldsForService(name) {
    const capitalizedName = this.capitalizedServiceName(name);
    const template = providers[capitalizedName];

    if (template) {
      const fields = template.fields();

      return _.map(fields, (field) => {
        if (!field.type) {
          field.type = field.property === "secret" ? "password" : "text";
        }

        return _.extend(field, {
          type: field.type
        });
      });
    }

    return [];
  }

  services(extendEach) {
    const availableServices = this.availableServices();
    const configurations = ServiceConfiguration.configurations.find().fetch();

    return _.map(availableServices, (name) => {
      const matchingConfigurations = _.filter(configurations, { service: name });
      let service = {
        name,
        label: this.capitalizedServiceName(name),
        fields: this.configFieldsForService(name)
      };

      if (matchingConfigurations.length) {
        service = _.extend(service, matchingConfigurations[0]);
      }

      if (_.isFunction(extendEach)) {
        service = _.extend(service, extendEach(service) || {});
      }

      return service;
    });
  }

  /**
   * @method addProvider
   * @memberof Accounts
   * @summary Add an OAuth provider, with field definitions required to render the form
   * which collects and stores configuation settings for the provider.
   * @example ServiceConfigHelper.addProvider("Untappd", [{ property: "clientId", label: "Client ID" }]), { property:
   *  "secret", label: "Client Secret" }]);
   * @see https://github.com/reactioncommerce/reaction/pull/3231
   * @param {String} provider Display Name of the provider
   * @param {Object[]} fields Array of plain old JavaScript objects with the keys `property`
   * ("apiKey", for example. `apiKey` should correspond to your OAuth provider's
   * implementation) and `label` ("API Key", for example)
   */
  static addProvider(provider, fields) {
    providers[provider] = {
      fields: () => fields
    };
  }
}
