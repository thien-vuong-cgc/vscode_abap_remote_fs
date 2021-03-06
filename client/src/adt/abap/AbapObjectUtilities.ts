import { MetaFolder } from "./../../fs/MetaFolder"
import { AbapInterface } from "./AbapInterface"
import { AdtServer } from "../AdtServer"
import {
  AbapObject,
  AbapNodeComponentByCategory,
  AbapXmlObject,
  NodeStructureMapped
} from "./AbapObject"
import { selectMap, ArrayToMap } from "../../helpers/functions"
import { AbapProgram } from "./AbapProgram"
import { AbapClass } from "./AbapClass"
import { AbapInclude } from "./AbapInclude"
import { AbapClassInclude, isClassInclude } from "./AbapClassInclude"
import { AbapNode, isAbapNode, AbapObjectNode } from "../../fs/AbapNode"
import { AbapFunction } from "./AbapFunction"
import { AbapCds } from "./AbapCds"
import { Node, ADTClient, NodeStructure } from "abap-adt-api"
import { AbapFunctionGroup } from "./AbapFunctionGroup"
import { Uri, commands } from "vscode"
import { PACKAGE, TMPPACKAGE } from "../operations/AdtObjectCreator"
import { log } from "../../helpers/logger"

export interface NodePath {
  path: string
  node: AbapNode
}

export function uriToNodePath(uri: Uri, node: AbapNode): NodePath {
  const path = uri.path
  return { path, node }
}

export function aggregateNodes(
  cont: NodeStructureMapped,
  parentType: string
): AbapNodeComponentByCategory[] {
  const catLabel = selectMap(cont.categories, "CATEGORY_LABEL", "")
  const typeCat = selectMap(cont.objectTypes, "CATEGORY_TAG", "")
  // in 7.52 labels are stored in types like 'DEVC/OC' instead of 'CLAS/OC'.
  // Not sure this is a proper fix but seems to work...
  const typeLabelBase = selectMap(cont.objectTypes, "OBJECT_TYPE_LABEL", "")
  const baseType = parentType.replace(/\/.*/, "")
  const typeLabel = (name: string) => {
    return typeLabelBase(name) || typeLabelBase(name.replace(/\w+/, baseType))
  }

  const components: AbapNodeComponentByCategory[] = []
  const findById = <T>(
    arr: T[],
    prop: string,
    value: string
  ): T | undefined => {
    return arr.find((x: any) => x[prop] === value)
  }

  cont.nodes
    .filter(o => o.OBJECT_NAME) // fix for 7.52 which returns unnamed package components. TODO investigate
    .forEach(node => {
      const categoryTag = typeCat(node.OBJECT_TYPE)
      const categoryLabel = catLabel(categoryTag)
      let catNode = findById(components, "category", categoryTag)
      if (!catNode) {
        catNode = {
          category: categoryTag,
          name: categoryLabel,
          types: []
        }
        components.push(catNode)
      }
      let typeNode = findById(catNode.types, "type", node.OBJECT_TYPE)
      if (!typeNode) {
        typeNode = {
          name: typeLabel(node.OBJECT_TYPE),
          type: node.OBJECT_TYPE,
          objects: []
        }
        catNode.types.push(typeNode)
      }
      typeNode.objects.push(abapObjectFromNode(node))
    })

  return components
}

export const convertNodes = (
  rawnodes: NodeStructure,
  type: string,
  filter?: (o: NodeStructureMapped) => NodeStructureMapped
) => {
  const nodes = {
    nodes: rawnodes.nodes,
    categories: ArrayToMap("CATEGORY")(rawnodes.categories),
    objectTypes: ArrayToMap("OBJECT_TYPE")(rawnodes.objectTypes)
  }
  const filtered = filter ? filter(nodes) : nodes
  const components = aggregateNodes(filtered, type)

  return components
}

export function abapObjectFromNode(node: Node): AbapObject {
  let objtype = AbapObject
  switch (node.OBJECT_TYPE) {
    case "PROG/P":
      objtype = AbapProgram
      break
    case "CLAS/OC":
      objtype = AbapClass
      break
    case "CLAS/I":
      objtype = AbapClassInclude
      break
    case "XSLT/VT":
      objtype = AbapXmlObject
      break
    case "INTF/OI":
      objtype = AbapInterface
      break
    case "FUGR/F":
      objtype = AbapFunctionGroup
      break
    case "FUGR/FF":
      objtype = AbapFunction
      break
    case "PROG/I":
    case "FUGR/I":
      objtype = AbapInclude
      break
    case "DDLS/DF":
    case "DCLS/DL":
    case "DDLX/EX":
      objtype = AbapCds
      break
  }
  return new objtype(
    node.OBJECT_TYPE,
    node.OBJECT_NAME,
    node.OBJECT_URI,
    node.EXPANDABLE,
    node.TECH_NAME
  )
}

export function findObjectInNodeByPath(
  folder: AbapNode,
  opath: string
): NodePath | undefined {
  const children = [...folder]
  for (const [path, node] of children) {
    if (isAbapNode(node)) {
      const o = node.abapObject
      if (o.path === opath) return { path: o.vsName || path, node }
    } else {
      const part = findObjectInNodeByPath(node, opath)
      if (part) return { ...part, path: `${path}/${part.path}` }
    }
  }
}

export async function findObjByPathAsync(
  folder: AbapNode,
  opath: string,
  server: AdtServer
) {
  const hit = findObjectInNodeByPath(folder, opath)
  if (hit) return hit
  await server.refreshDirIfNeeded(folder)
  return findObjectInNodeByPath(folder, opath)
}

export function findObjectInNode(
  folder: AbapNode,
  type: string,
  name: string
): NodePath | undefined {
  const children = [...folder]
  for (const [path, node] of children) {
    if (isAbapNode(node)) {
      const o = node.abapObject
      if (o.type === type && o.name === name)
        return { path: o.vsName || path, node }
    } else {
      const part = findObjectInNode(node, type, name)
      if (part) return { ...part, path: `${path}/${part.path}` }
    }
  }
}

export function allChildren(o: NodePath): NodePath[] {
  if (o.node.numChildren === 0) return []
  const children: NodePath[] = [...o.node].map(x => {
    return { path: o.path + "/" + x[0], node: x[1] }
  })

  let all = children
  for (const child of children) {
    all = [...all, ...allChildren(child)]
  }
  return all
}

export function findMainInclude(o: NodePath) {
  if (!isAbapNode(o.node)) return
  const candidates = allChildren(o).filter(
    x => isAbapNode(x.node) && !x.node.isFolder
  )
  const main = candidates.find(
    x => isAbapNode(x.node) && !!x.node.abapObject.path.match("/source/main")
  )
  return main || candidates[0]
}

export async function findMainIncludeAsync(nPath: NodePath, c: ADTClient) {
  if (!isAbapNode(nPath.node)) return
  const main = findMainInclude(nPath)
  if (main) return main
  await nPath.node.refresh(c)
  return findMainInclude(nPath)
}

// to support ABAPLINT we need to follow its naming conventions
// for most object types an extension is good enough
// function modules are an exception, for now it won't work for them
const TYPES: any = {
  "PROG/P": ".prog",
  "PROG/I": ".prog",
  "FUGR/I": ".prog",
  "CLAS/I": ".clas",
  "INTF/OI": ".intf",
  "FUGR/FF": ".fugr"
}
const CLASSINCLUDES: any = {
  testclasses: ".testclasses",
  definitions: ".locals_def",
  implementations: ".locals_imp",
  macros: ".macros",
  main: ""
}
export function objectTypeExtension(obj: AbapObject): string {
  if (isClassInclude(obj)) {
    const incltype = obj.name.replace(/.*\./, "")
    switch (incltype) {
      case "main":
      case "":
        return ".clas"
      default:
        return `.clas${CLASSINCLUDES[incltype] || "." + incltype}`
    }
  }
  return TYPES[obj.type] || ""
}
