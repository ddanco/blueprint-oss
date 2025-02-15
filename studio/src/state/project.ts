import memo from 'memoizee';
import {v4 as uuidv4} from 'uuid';

import * as RecordTargets from 'studio/foundation/recordTargets';
import * as Entity from 'studio/foundation/entity';
import * as TargetValue from 'studio/foundation/targetValue';
import * as Targets from 'studio/foundation/targets';
import * as Schema from 'studio/foundation/targetsSchema';
import * as Text from 'studio/foundation/text';

import {Value as TheSessionContext} from 'studio/context/SessionContext';

import * as Model from 'studio/blueprint/model';
import * as Results from 'studio/blueprint/results';
import * as Node from 'studio/blueprint/node';
import * as Rule from 'studio/blueprint/rule';

import * as RecordRun from 'studio/state/recordRun';
import * as ModelRun from 'studio/state/modelRun';
import * as NodeRecordTargets from 'studio/state/nodeRecordTargets';
import * as Resource from 'studio/state/resource';
import * as Settings from 'studio/state/settings';

import * as ExtractionAndTargets from 'studio/accuracy/extractionAndTargets';

import assert from 'studio/util/assert';
import {Nonempty, UUID} from 'studio/util/types';

import {loadRecordNames} from 'studio/async/loadRecords';

// If you make a breaking change to the Project type, bump this number,
// and projects whose files are in an old version will gracefully fail to load.
export const FORMAT_VERSION = 7;

export type t = {
  formatVersion: number;
  uuid: UUID;

  samplesPath: string;
  selectedRecordName: string | undefined;

  targets: Targets.t;

  modelStack: Nonempty<Model.t[]>;
  currentModelIndex: number;
  selectedNodeModelPath: Model.Path | undefined;
  selectionMode: SelectionMode;

  modelRuns: Readonly<Array<ModelRun.t>>;

  settings: Settings.t;
};

export type SelectionMode = {
  type: 'None';
} | {
  type: 'Field';
  field: string;
} | {
  type: 'Rule';
  ruleUUID: UUID;
};

export function build(
  samplesPath: string,
): t {
  return {
    formatVersion: FORMAT_VERSION,
    uuid: uuidv4(),

    samplesPath,
    selectedRecordName: undefined,

    targets: Targets.build(),

    modelStack: [Model.build()],
    currentModelIndex: 0,
    selectedNodeModelPath: undefined,
    selectionMode: {type: 'None'},

    modelRuns: [],

    settings: Settings.build(),
  };
}

export function hasSelectedRecordName(project: t): boolean {
  return project.selectedRecordName != undefined;
}

export function recordTargets(
  project: t,
  recordName: string | undefined):
    RecordTargets.t | undefined
{
  if (recordName == undefined) {
    return undefined;
  } else {
    return Targets.recordTargets(project.targets, recordName);
  }
}

export function selectedRecordTargets(
  project: t):
    RecordTargets.t | undefined
{
  const recordName = project.selectedRecordName;
  if (recordName != undefined) {
    return recordTargets(project, recordName);
  }
}

export function nodeRecordTargets(
  project: t,
  node: Node.t | undefined):
    NodeRecordTargets.t | undefined
{
  const recordTargets = selectedRecordTargets(project);
  if (recordTargets != undefined && node != undefined) {
    return NodeRecordTargets.build(node, recordTargets);
  }
}

export function model(project: t): Model.t {
  return project.modelStack[project.currentModelIndex];
}

export function selectedNode(project: t): Node.t | undefined {
  if (project.selectedNodeModelPath) {
    return Model.node(
      model(project),
      project.selectedNodeModelPath);
  }
}

export function selectedRule(project: t): Rule.t | undefined {
  switch (project.selectionMode.type) {
    case 'None':
    case 'Field':
      return undefined;
    case 'Rule':
      const node = selectedNode(project);
      if (node != undefined) {
        return Node.rule(node, project.selectionMode.ruleUUID);
      }
  }
  return <never>undefined;
}

export function selectedField(project: t): string | undefined {
  if (project.selectionMode.type == 'Field') {
    return project.selectionMode.field;
  }
}

export function pushModel(project: t, model: Model.t): t {
  const modelStack = project.modelStack.slice(0, project.currentModelIndex + 1)
    .concat([model]) as Nonempty<Model.t[]>;
  return {
    ...project,
    modelStack,
    currentModelIndex:
      project.currentModelIndex + 1,
    selectedNodeModelPath:
      project.selectedNodeModelPath &&
      Model.maximalValidSubpath(
        model, project.selectedNodeModelPath),
    selectionMode: {type: 'None'},

    modelRuns: project.modelRuns.filter(
      modelRun => modelRun.modelIndex <= project.currentModelIndex),

    targets: {
      ...project.targets,
      schema:
        syncSchemaTypes(
          model,
          project.targets.schema),
    },
  };
}

export function setSelectedNode(project: t, path: Model.Path): t {
  return {
    ...project,
    selectedNodeModelPath:
      Model.maximalValidSubpath(
        model(project), path),
  };
}

export function nodeIsSelected(project: t, node: Node.t): boolean {
  const path = project.selectedNodeModelPath;
  if (path) {
    return node.uuid == path[path.length - 1];
  } else {
    return false;
  }
}

export function childIsSelected(project: t, node: Node.t): boolean {
  if (project.selectedNodeModelPath) {
    return project.selectedNodeModelPath.slice(0, -1).some(
      uuid => node.uuid == uuid);
  } else {
    return false;
  }
}

export function ruleIsSelected(project: t, rule: Rule.t): boolean {
  return project.selectionMode.type == 'Rule' &&
    rule.uuid == project.selectionMode.ruleUUID;
}

export function canUndo(project: t): boolean {
  return project.currentModelIndex > 0;
}

export function canRedo(project: t): boolean {
  return project.currentModelIndex + 1 < project.modelStack.length;
}

export const modelRunsForCurrentModel = memo(
  function(
    project: t):
      Array<ModelRun.t>
  {
    return project.modelRuns.filter(
      modelRun =>
        modelRun.modelIndex == project.currentModelIndex);
  },
  { max: 10 },
);

export const resultsForCurrentModelAndDoc = memo(
  function(
    project: t,
    recordName: string):
      Results.t | undefined
  {
    return ModelRun.resultsForDoc(
      modelRunsForCurrentModel(project),
      recordName);
  },
  { max: 10 },
);

export const resultsForCurrentModelAndSelectedRecordName = memo(
  function(
    project: t):
      Results.t | undefined
  {
    const recordName = project.selectedRecordName;
    if (recordName) {
      return resultsForCurrentModelAndDoc(project, recordName);
    }
  },
  { max: 10 },
);

export const pendingModelRecordRuns = memo(
  function(project: t):
    Array<RecordRun.PendingRecordRun>
  {
    return ModelRun.pendingModelRecordRuns(project.modelRuns);
  },
  { max: 10 },
);

export const extractionsAndTargets = memo(
  function(
    recordNames: string[],
    targets: Targets.t | undefined,
    modelRun: ModelRun.t | undefined):
      ExtractionAndTargets.t[]
  {
    // console.log('Calculating extractions & targets', recordNames, targets, modelRun);
    return [...recordNames]
      .map(recordName => {
        const recordRun =
          modelRun &&
          ModelRun.recordRun(
            modelRun,
            recordName);
        const results =
          recordRun &&
          RecordRun.results(
            recordRun);
        const extraction =
          results &&
          Results.bestExtraction(
            results);
        const recordTargets =
          targets &&
          Targets.recordTargets(
            targets,
            recordName);
        return [extraction, recordTargets];
      })
  },
  { max: 10 },
);

type FieldTypePair = [string, Entity.Type];

export const syncSchemaTypes = memo(
  function(
    model: Model.t,
    schema: Schema.t):
      Schema.t
  {
    const schemaFieldIsOk = (field: string) => (
      Model.fieldType(model, field) == undefined ||
      Model.fieldType(model, field) == Schema.type(schema, field)
    );

    if (Schema.fields(schema).every(schemaFieldIsOk)) {
      return schema;
    } else {
      return schema.map(
        entry => {
          if (schemaFieldIsOk(entry.field)) {
            return entry;
          } else {
            const type = Model.fieldType(model, entry.field);
            assert(type != undefined);
            return {
              ...entry,
              type,
            };
          }
        }
      );
    }
  },
  { max: 10 },
);

export function isLabel(project: t, field: string): boolean | undefined {
  // Super janky.
  const entry = Schema.entry(project.targets.schema, field);
  return entry?.is_label;
}

export function annotationMode(project: t): boolean {
  return project.settings.annotationMode;
}

export function targetPickingEnabled(project: t): boolean {
  return selectedField(project) != undefined;
}

export function targetValueForSelectedRecordName(
  project: t,
  field: string):
    TargetValue.t | undefined
{
  const recordTargets = selectedRecordTargets(project);
  return recordTargets && RecordTargets.value(recordTargets, field);
}

export const activeRecordNames = memo(
  async function(project: t): Promise<string[]> {
    const recordNames = await loadRecordNames(project.samplesPath);
    return recordNames.filter(
      recordName => {
        const targets = recordTargets(project, recordName);

        if (project.settings.requiredDocTags) {
          if (targets == undefined) {
            return false;
          }

          const individualTags = project.settings.requiredDocTags.split(' ').filter(s => s);
          if (individualTags.length > 0) {
            for (let tag of individualTags) {
              if (!targets.doc_tags.includes(tag)) {
                return false;
              }
            }
          }
        }

        return true;
      }
    );
  }
);

export function blueprintSettings(project: t): Settings.BlueprintSettings {
  return buildBlueprintSettingsFromProjectSettings(
    project.settings.config_numSamples,
    project.settings.config_timeout,
  );
}

const buildBlueprintSettingsFromProjectSettings = memo(
  function(
    config_numSamples: number,
    config_timeout: number,
  ): Settings.BlueprintSettings
  {
    return {
      config_numSamples,
      config_timeout,
    };
  }
);
