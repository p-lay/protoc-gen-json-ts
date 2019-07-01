import { join } from "path";
import {
  FileDescriptorProto,
  DescriptorProto,
  EnumDescriptorProto,
  ServiceDescriptorProto,
  MethodDescriptorProto,
  FieldDescriptorProto
} from "google-protobuf/google/protobuf/descriptor_pb";
import getImportedTypesContext from "./ImportedTypesContext";

import { strRepeat } from "./util";

export interface ImportedType {
  packageName: string;
  path: string;
  name: string;
}

const lineSplitter = "\n";

const typeCast = (
  field: FieldDescriptorProto,
  mapEntriesMap: { [key: string]: DescriptorProto },
  fileName: string
): string => {
  const type = field.getType();
  const label = field.getLabel();
  const typeName = field.getTypeName();
  const types = FieldDescriptorProto.Type;
  const labels = FieldDescriptorProto.Label;
  const context = getImportedTypesContext();

  let typeStr = "string";
  switch (type) {
    case types.TYPE_INT32:
    case types.TYPE_FIXED32:
    case types.TYPE_UINT32:
    case types.TYPE_FLOAT:
    case types.TYPE_DOUBLE:
      typeStr = "number";
      break;
    case types.TYPE_BOOL:
      typeStr = "boolean";
      break;
    case types.TYPE_ENUM:
      typeStr = context.getTypeName(typeName, fileName);
      break;
    case types.TYPE_MESSAGE: {
      if (mapEntriesMap[typeName]) {
        return `{[key: string]: ${typeCast(
          mapEntriesMap[typeName].getFieldList()[1],
          {},
          fileName
        )}}`;
      } else {
        typeStr = context.getTypeName(typeName, fileName);
      }
      break;
    }
  }
  return `${typeStr}${label === labels.LABEL_REPEATED ? "[]" : ""}`;
};

const renderAllEnums = (
  enums: EnumDescriptorProto[] = [],
  parentTypeName = ""
) => {
  enums = enums.filter(enumObj => Object.keys(enumObj).length > 0);
  if (enums.length > 0) {
    return enums
      .map(oneEnum => {
        return `
export enum ${parentTypeName}${oneEnum.getName()} {
${oneEnum
          .getValueList()
          .map(value => `  ${value.getName()} = "${value.getName()}",`)
          .join(lineSplitter)}
}
`;
      })
      .join("");
  }
  return "";
};

const renderAllMessages = (
  messages: DescriptorProto[] = [],
  packageName: string,
  fileName: string,
  parentTypeName = ""
) => {
  return messages
    .map(message => {
      const name = message.getName();
      const fields = message.getFieldList();
      const nestedTypes = message
        .getNestedTypeList()
        .filter(
          type =>
            type.getOptions() === undefined || !type.getOptions().getMapEntry()
        );
      let retStr = "";
      retStr += renderAllMessages(
        nestedTypes,
        packageName,
        fileName,
        `${parentTypeName}${message.getName()}`
      );
      retStr += renderAllEnums(
        message.getEnumTypeList(),
        `${parentTypeName}${message.getName()}`
      );
      const mapEntriesMap = message
        .getNestedTypeList()
        .filter(type => type.getOptions() && type.getOptions().getMapEntry())
        .reduce<{ [key: string]: DescriptorProto }>((pValue, cValue) => {
          return {
            ...pValue,
            [`.${packageName}.${name}.${cValue.getName()}`]: cValue
          };
        }, {});

      return (retStr += `
export interface ${parentTypeName}${name} {
${fields
        .reduce<string[]>((lines, field) => {
          const fieldType = typeCast(field, mapEntriesMap, fileName);
          lines.push(`  ${field.getName()}: ${fieldType}`);
          return lines;
        }, [])
        .join(`${lineSplitter}`)}
}
`);
    })
    .join("");
};

const renderMethods = (
  methods: MethodDescriptorProto[],
  packageName: string,
  serviceName: string,
  fileName: string,
  isServer: boolean
) => {
  const context = getImportedTypesContext();
  return methods
    .map(method => {
      const name = method.getName();
      const inputType = context.getTypeName(method.getInputType(), fileName);
      const outputType = context.getTypeName(method.getOutputType(), fileName);
      if (isServer) {
        return `
export function ${name}(app: Express, handler: (params: ${inputType}) => Promise<${outputType}>) {
  return webapi<${inputType}, ${outputType}>("${
          packageName === "" ? "" : `${packageName}.`
        }${serviceName}/${name}", app, handler, { method: "POST" });
}
        `;
      }
      return `
export function ${name}(payload: ${inputType}) {
  return webapi<${outputType}>("${
        packageName === "" ? "" : `${packageName}.`
      }${serviceName}/${name}", payload);
}`;
    })
    .join("");
};

const renderService = (
  service: ServiceDescriptorProto,
  packageName: string,
  fileName: string,
  isServer: boolean
) => {
  return `
${renderMethods(
    service.getMethodList(),
    packageName,
    service.getName(),
    fileName,
    isServer
  )}

export default {
${service
    .getMethodList()
    .map(method => `  ${method.getName()},`)
    .join(lineSplitter)}
}
`;
};

function renderImportSection(
  hasService: boolean,
  webapiPath: string,
  fileName: string,
  isServer: boolean
) {
  const referenceMap = getImportedTypesContext().getReferenceMap(fileName);

  return `
${Object.keys(referenceMap === undefined ? {} : referenceMap)
    .map(refFileName => {
      const refsArr = referenceMap[refFileName];
      return `import { ${refsArr
        .map(({ alias, origin }) => `${origin} as ${alias}`)
        .join(", ")} } from "${refFileName}";`;
    })
    .join(lineSplitter)}
${
    isServer
      ? `
import { Express } from "express"
`
      : ""
  }
${hasService ? `import webapi from "${webapiPath}";` : ""}
  `.trim();
}

const template = (
  data: FileDescriptorProto,
  apiPath: string,
  isServer: boolean = false
) => {
  const messages = data.getMessageTypeList();
  const enums = data.getEnumTypeList();
  const services = data.getServiceList();
  const hasService = Array.isArray(services) && services.length > 0;
  const packageName = data.getPackage();
  const fileName = data.getName();

  const webapiPath = join(
    strRepeat("../", packageName.split(/\./g).length),
    apiPath
  );

  let returnStr = `
${renderAllEnums(enums)}
${renderAllMessages(messages, packageName, fileName)}
${hasService ? renderService(services[0], packageName, fileName, isServer) : ""}

`.trim();
  returnStr =
    `
/**
 * This file is auto-generated by protobuf
 * Don't change manually
 */

${renderImportSection(hasService, webapiPath, fileName, isServer)}

` + returnStr;
  return returnStr.trim();
};

export default template;
