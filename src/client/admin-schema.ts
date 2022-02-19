import * as _ from 'lodash';

export class AdminSchema {

    constructor(
        private adminServerSchema: any
    ) {}

    public queryTypeDefined(queryType: string): boolean {
        return this.typeHasField('Query', queryType);
    }

    public typeHasField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.adminServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.fields, { name: fieldName });
    }

    public asOptionalField(typeName: string, fieldName: string): string {
        return (this.typeHasField(typeName, fieldName))
            ? fieldName
            : '';
    }

    public typeHasInputField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.adminServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.inputFields, { name: fieldName });
    }

}